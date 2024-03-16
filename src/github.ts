import {
  GetResponseDataTypeFromEndpointMethod,
  GetResponseTypeFromEndpointMethod,
} from "@octokit/types";
import { octokit } from "./serviceWorker";
import {
  getMonitoringEnabledRepos,
  getNotMyTurnBlockList,
  getRepoStateByFullName,
  MyPR,
  MyPRReviewStatus,
  NotMyTurnBlock,
  PR,
  Repo,
  RepoState,
  RepoSyncResult,
  ReviewOnMyPR,
  ReviewRequest,
  ReviewRequestOnMyPR,
  ReviewState,
  storeRepoStateMap,
} from "./storage";

const PULLS_PER_PAGE = 100;
const REVIEWS_PER_PAGE = 100;

type PullsListResponseType = GetResponseTypeFromEndpointMethod<
  typeof octokit.pulls.list
>;
type PullsListResponseDataType = GetResponseDataTypeFromEndpointMethod<
  typeof octokit.pulls.list
>;
type PullsListReviewsResponseType = GetResponseTypeFromEndpointMethod<
  typeof octokit.pulls.listReviews
>;
type PullsListReviewsResponseDataType = GetResponseDataTypeFromEndpointMethod<
  typeof octokit.pulls.listReviews
>;

type IssuesListEventsResponseType = GetResponseTypeFromEndpointMethod<
  typeof octokit.issues.listEvents
>;
type IssuesListEventsResponseDataType = GetResponseDataTypeFromEndpointMethod<
  typeof octokit.issues.listEvents
>;

let gitHubCallsCounter = 0;
let syncStartUnixMillis = 0;

export enum SyncStatus {
  Green = -1,
  Yellow = 0,
  Red = 1,
  Grey = 2,
}

function getStatus(repoSyncResult: RepoSyncResult) {
  const requestForMyReviewStatus =
    repoSyncResult.requestsForMyReview.length > 0
      ? SyncStatus.Red
      : SyncStatus.Green;
  // Yellow max based on myPRs. TODO(36): make it user-configurable:
  const myPRsStatus = repoSyncResult.myPRs.some(
    (pr) => pr.getStatus() != MyPRReviewStatus.NONE,
  )
    ? SyncStatus.Yellow
    : SyncStatus.Green;
  return Math.max(requestForMyReviewStatus, myPRsStatus);
}

/**
 * Note: no concurrent calls!
 */
export async function sync(myGitHubUserId: number): Promise<SyncStatus> {
  // #NOT_MATURE: what if it manages to exceed the quota in a single sync?
  await throttle();

  gitHubCallsCounter = 0;
  syncStartUnixMillis = Date.now();
  const repos = await getMonitoringEnabledRepos();
  const repoStateByFullName = await getRepoStateByFullName();
  const newRepoStateByFullName = new Map<string, RepoState>();
  let result = SyncStatus.Green;
  // It's probably better to do these GitHub requests in a sequential manner so that GitHub is not
  // tempted to block them even if user monitors many repos:
  for (const repo of repos) {
    let repoState = repoStateByFullName.get(repo.fullName());
    if (!repoState) {
      repoState = new RepoState(repo.fullName());
    }
    newRepoStateByFullName.set(repo.fullName(), repoState);
    result = Math.max(result, await syncRepo(repoState, myGitHubUserId));
  }

  // Update in background:
  storeRepoStateMap(newRepoStateByFullName);

  const latestRepos = await getMonitoringEnabledRepos();
  if (
    latestRepos.some((repo) => !newRepoStateByFullName.get(repo.fullName()))
  ) {
    // Not synced for some of the latest repos snapshot.
    result = SyncStatus.Grey;
  }

  console.log(gitHubCallsCounter + " GitHub API calls in the last sync");

  return result;
}

/**
 * Returns 2 for grey icon, 1 for red, 0 for yellow, -1 for green..
 *
 * @param repo The repo state will be updated as a result of the call.
 */
async function syncRepo(
  repo: RepoState,
  myGitHubUserId: number,
): Promise<SyncStatus> {
  const repoSyncResult = new RepoSyncResult();
  repoSyncResult.syncStartUnixMillis = Date.now();
  const requestsForMyReviewBuilder = [] as ReviewRequest[];
  const myPRsToSyncBuilder = [] as PullsListResponseDataType[0][];

  try {
    let pageNumber = 1;
    let pullsListResponse: PullsListResponseType;
    do {
      pullsListResponse = await listPullRequests(repo, pageNumber);
      for (const arrayElement of pullsListResponse.data) {
        const pr = arrayElement as PullsListResponseDataType[0];
        if (pr.user.id == myGitHubUserId) {
          myPRsToSyncBuilder.push(pr);
        } else {
          // Somebody else's PR
          for (const reviewer of pr.requested_reviewers) {
            if (reviewer.id === myGitHubUserId) {
              const reviewRequest = await syncRequestForMyReview(
                pr,
                repo,
                myGitHubUserId,
              );
              requestsForMyReviewBuilder.push(reviewRequest);
            }
          }
        }
      }
      pageNumber++;
    } while (pullsListResponse.data.length > 0);
    // If review request was withdrawn and then re-requested again the first request will be
    // (correctly) ignored:
    repoSyncResult.requestsForMyReview = requestsForMyReviewBuilder;

    // Minimizing the chances of race conditions with the "not my turn" blocks:
    const notMyTurnBlockList = await getNotMyTurnBlockList();
    const myPRsBuilder = [] as MyPR[];
    for (const pr of myPRsToSyncBuilder) {
      const myPR = await syncMyPR(pr, repo, notMyTurnBlockList);
      myPRsBuilder.push(myPR);
    }
    repoSyncResult.myPRs = myPRsBuilder;

    repo.lastSuccessfulSyncResult = repoSyncResult;
    repo.lastSyncResult = repoSyncResult;
    return getStatus(repoSyncResult);
  } catch (e) {
    console.warn(
      `Error listing pull requests from ${repo.fullName}. Ignoring it.`,
      e,
    );
    repoSyncResult.errorMsg = e + "";
    repo.lastSyncResult = repoSyncResult;

    if (repo.hasRecentSuccessfulSync()) {
      return getStatus(repo.lastSuccessfulSyncResult);
    } else {
      return SyncStatus.Grey;
    }
  }
}

async function syncMyPR(
  pr: PullsListResponseDataType[0],
  repo: RepoState,
  notMyTurnBlockList: NotMyTurnBlock[],
) {
  const reviewsRequested = pr.requested_reviewers.map((reviewer) => {
    const url = pr.html_url;
    // To have an up-to-date title:
    const pullRequest = new PR(url, pr.title);
    return new ReviewRequestOnMyPR(pullRequest, reviewer.id);
  });

  // Now query reviews already received:
  let reviews: PullsListReviewsResponseDataType = [];
  let pageNumber = 1;
  let reviewsBatch = await listReviews(repo, pr.number, pageNumber);
  while (reviewsBatch.data.length >= REVIEWS_PER_PAGE) {
    reviews = reviews.concat(reviewsBatch.data);
    pageNumber++;
    reviewsBatch = await listReviews(repo, pr.number, pageNumber);
  }
  reviews = reviews.concat(reviewsBatch.data);

  const prObj = new PR(pr.html_url, pr.title);
  const reviewsReceived = reviews.map((review) => {
    const state = review.state;
    const typedState = state as keyof typeof ReviewState;
    return new ReviewOnMyPR(
      prObj,
      review.user.id,
      ReviewState[typedState],
      Date.parse(review.submitted_at),
    );
  });
  return MyPR.ofGitHubResponses(
    prObj,
    reviewsReceived,
    reviewsRequested,
    pr.user.id,
    notMyTurnBlockList,
  );
}

async function syncRequestForMyReview(
  pr: PullsListResponseDataType[0],
  repo: RepoState,
  myGitHubUserId: number,
): Promise<ReviewRequest> {
  let reviewRequestedUnixMillis: number;
  try {
    reviewRequestedUnixMillis = await getLatestReviewRequestedEventTimestamp(
      pr,
      repo,
      myGitHubUserId,
    );
  } catch (e) {
    console.error(
      "Couldn't get the real review_requested timestamp. Will use an approximation instead.",
      e,
    );
  }

  const url = pr.html_url;
  let matchingReviewRequests = [] as ReviewRequest[];
  if (
    repo.lastSuccessfulSyncResult &&
    repo.lastSuccessfulSyncResult.requestsForMyReview
  ) {
    matchingReviewRequests =
      repo.lastSuccessfulSyncResult.requestsForMyReview.filter((existing) => {
        const existingUrl = existing.pr.url;
        return existingUrl === url;
      });
  }
  // To have an up-to-date title:
  const pullRequest = new PR(url, pr.title);
  if (matchingReviewRequests.length == 0) {
    return new ReviewRequest(
      pullRequest,
      reviewRequestedUnixMillis ? reviewRequestedUnixMillis : Date.now(),
    );
  } else {
    const existingReviewRequest = matchingReviewRequests[0];
    return new ReviewRequest(
      pullRequest,
      reviewRequestedUnixMillis
        ? reviewRequestedUnixMillis
        : existingReviewRequest.firstTimeObservedUnixMillis,
    );
  }
}

async function getLatestReviewRequestedEventTimestamp(
  pr: PullsListResponseDataType[0],
  repo: RepoState,
  myGitHubUserId: number,
): Promise<number> {
  let result = 0;
  let pageNumber = 1;
  let eventsListResponse: IssuesListEventsResponseType;
  do {
    eventsListResponse = await listEvents(repo, pr.number, pageNumber);
    for (const arrayElement of eventsListResponse.data) {
      const event = arrayElement as IssuesListEventsResponseDataType[0];
      if (
        event.event === "review_requested" &&
        event.requested_reviewer.id === myGitHubUserId
      ) {
        result = Math.max(result, new Date(event.created_at).getTime());
      }
    }
    pageNumber++;
  } while (eventsListResponse.data.length > 0);
  return result;
}

async function listPullRequests(
  repo: RepoState,
  pageNumber: number,
  retryNumber = 0,
): Promise<PullsListResponseType> {
  try {
    // A little hack just to get repo owner and name:
    const r = Repo.fromFullName(repo.fullName);
    if (retryNumber > 0) {
      // exponential backoff:
      await delay(1000 * Math.pow(2, retryNumber - 1));
    }
    gitHubCallsCounter++;
    return await octokit.pulls.list({
      owner: r.owner,
      repo: r.name,
      state: "open",
      per_page: PULLS_PER_PAGE,
      page: pageNumber,
      headers: {
        "X-GitHub-Api-Version": "2022-11-28",
        // no caching:
        "If-None-Match": "",
      },
    });
  } catch (e) {
    if (retryNumber > 2) {
      console.error("The maximum number of retries reached");
      throw e;
    } else {
      return await listPullRequests(repo, pageNumber, retryNumber + 1);
    }
  }
}

async function listReviews(
  repo: RepoState,
  pullNumber: number,
  pageNumber: number,
  retryNumber = 0,
): Promise<PullsListReviewsResponseType> {
  try {
    // A little hack just to get repo owner and name:
    const r = Repo.fromFullName(repo.fullName);
    if (retryNumber > 0) {
      // exponential backoff:
      await delay(1000 * Math.pow(2, retryNumber - 1));
    }
    gitHubCallsCounter++;
    return await octokit.pulls.listReviews({
      owner: r.owner,
      repo: r.name,
      pull_number: pullNumber,
      per_page: PULLS_PER_PAGE,
      page: pageNumber,
      headers: {
        "X-GitHub-Api-Version": "2022-11-28",
        // no caching:
        "If-None-Match": "",
      },
    });
  } catch (e) {
    if (retryNumber > 2) {
      console.error("The maximum number of retries reached");
      throw e;
    } else {
      return await listReviews(repo, pullNumber, pageNumber, retryNumber + 1);
    }
  }
}

async function listEvents(
  repo: RepoState,
  pullNumber: number,
  pageNumber: number,
  retryNumber = 0,
): Promise<IssuesListEventsResponseType> {
  try {
    // A little hack just to get repo owner and name:
    const r = Repo.fromFullName(repo.fullName);
    if (retryNumber > 0) {
      // exponential backoff:
      await delay(1000 * Math.pow(2, retryNumber - 1));
    }
    gitHubCallsCounter++;
    return await octokit.issues.listEvents({
      owner: r.owner,
      repo: r.name,
      issue_number: pullNumber,
      page: pageNumber,
      headers: {
        "X-GitHub-Api-Version": "2022-11-28",
        // no caching:
        "If-None-Match": "",
      },
    });
  } catch (e) {
    if (retryNumber > 2) {
      console.error("The maximum number of retries reached");
      throw e;
    } else {
      return await listEvents(repo, pullNumber, pageNumber, retryNumber + 1);
    }
  }
}

// should prevent throttling by GitHub
async function throttle() {
  const secondsSinceLastSyncStart = (Date.now() - syncStartUnixMillis) / 1000;
  if (secondsSinceLastSyncStart < 2 * gitHubCallsCounter) {
    // to be on a safe side target 0.5 RPS (it's 5000 requests per hour quota):
    const waitMs = (2 * gitHubCallsCounter - secondsSinceLastSyncStart) * 1000;
    console.log(
      "Throttling GitHub calls to 0.5 RPS. Waiting for " + waitMs + "ms",
    );
    await delay(waitMs);
  }
}

function delay(milliseconds: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
