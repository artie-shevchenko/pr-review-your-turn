import "../styles/popup.scss";
import { Octokit } from "@octokit/rest";
import { CommentBlock, MyPrBlock, ReviewRequestBlock } from "./block";
import { GitHubUser } from "./gitHubUser";
import { Repo } from "./repo";
import { RepoState } from "./repoState";
import { ReasonNotIgnored, ReviewRequest } from "./reviewRequest";
import { ReviewState } from "./reviewState";
import { Settings } from "./settings";
import {
  addCommentBlock,
  addMyPrBlock,
  addReviewRequestBlock,
  getCommentBlockList,
  getGitHubUser,
  getHideLeaveExtensionReviewDiv,
  getInstallationUnixMillis,
  getLastSyncDurationMillis,
  getMonitoringEnabledRepos,
  getMyPrBlockList,
  getReposState,
  getReviewRequestBlockList,
  getSettings,
  storeGitHubUser,
  storeHideLeaveExtensionReviewDiv,
  storeSettings,
} from "./storage";
import { trySyncWithCredentials } from "./sync";

document.getElementById("go-to-options").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

document.getElementById("hideComments").addEventListener("click", () => {
  getSettings().then((settings) => {
    document.getElementById("commentsDiv").style.display = "none";
    document.getElementById("commentsTable").style.display = "none";
    settings.ignoreCommentsMoreThanXDaysOld = 0;
    return storeSettings(settings);
  });
});

document
  .getElementById("showBlocked")
  .addEventListener("click", () => updatePopupPage());

document.getElementById("tokenForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const newToken = (
    document.getElementById("newToken") as HTMLInputElement
  ).value.trim();
  new Octokit({
    auth: newToken,
  })
    .request("GET /user", {
      headers: {
        "X-GitHub-Api-Version": "2022-11-28",
      },
    })
    .then((v) => {
      const userId = v.data.id;
      console.log("GitHub user ID: " + userId);
      const gitHubUser = new GitHubUser(userId, newToken);
      const result = storeGitHubUser(gitHubUser);
      // trigger sync:
      trySyncWithCredentials(gitHubUser);
      return result;
    })
    .then(() => {
      chrome.tabs.create({ active: true, url: "/options.html" });
      window.close();
    })
    .catch((e) => {
      showError(e);
    });
});

class NoGitHubToken extends Error {}

getGitHubUser()
  .then((gitHubUser) => {
    if (gitHubUser && gitHubUser.token) {
      try {
        return new Octokit({
          auth: gitHubUser.token,
        }).request("GET /user", {
          headers: {
            "X-GitHub-Api-Version": "2022-11-28",
          },
        });
      } catch (e) {
        throw new Error(
          "Could not get GitHub user. GitHub GET /user returned" + e,
        );
      }
    } else {
      throw new NoGitHubToken();
    }
  })
  .then((user) => {
    if (user && user.data && user.data.id) {
      updatePopupPage();
      document.getElementById("main").style.display = "block";

      setInterval(function () {
        updatePopupPage();
      }, 60000);
    } else {
      throw new Error(
        "Could not get GitHub user. GitHub GET /user returned: " + user,
      );
    }
    // trigger:
    maybeShowLeaveExtensionReview();
  })
  .catch((e) => {
    showError(e);
  });

async function maybeShowLeaveExtensionReview() {
  const hideLeaveExtensionReviewDiv = await getHideLeaveExtensionReviewDiv();
  if (hideLeaveExtensionReviewDiv) {
    return;
  }

  const installationUnixMillis = await getInstallationUnixMillis();
  if (
    !installationUnixMillis ||
    (new Date().getTime() - installationUnixMillis) / 1000 / 60 / 60 / 24 > 14
  ) {
    const leaveExtensionReviewDiv = document.getElementById(
      "leaveExtensionReview",
    );
    leaveExtensionReviewDiv.style.display = "block";
    document
      .getElementById("hideLeaveExtensionReviewButton")
      .addEventListener("click", async () => {
        await storeHideLeaveExtensionReviewDiv(true);
        leaveExtensionReviewDiv.style.display = "none";
      });
  }
}

const BAD_CREDENTIALS_GITHUB_ERROR_MSG = "Bad credentials";

function showError(e: Error) {
  document.getElementById("auth").style.display = "block";
  if (e instanceof NoGitHubToken) {
    // That's a part of the init flow, not an error.
    document.getElementById("setup").style.display = "block";
  } else {
    const errorDiv = document.getElementById("error");
    errorDiv.style.display = "block";
    if (e.message === BAD_CREDENTIALS_GITHUB_ERROR_MSG) {
      errorDiv.innerHTML =
        "Error: Bad GitHub credentials. Likely the GitHub access token expired and needs to be updated. Follow the instructions below.<br/><br/>";
    } else if (e.message.includes("API rate limit exceeded")) {
      errorDiv.innerHTML =
        "Oops, we got throttled by GitHub... Sync will be retried later.<br/><br/>";
    } else {
      errorDiv.innerHTML =
        "Something went wrong. If the error persists it may be a problem with the provided GitHub auth token.<br/><br/>" +
        e;
    }
  }
}

async function updatePopupPage() {
  const reposState = await getReposState();
  const repos: Repo[] = await getMonitoringEnabledRepos();
  const myPrBlocks = await getMyPrBlockList();
  const reviewRequestBlocks = await getReviewRequestBlockList();
  const commentBlocks = await getCommentBlockList();
  const settings = await getSettings();
  await reposState.updateIcon(
    repos,
    myPrBlocks,
    reviewRequestBlocks,
    commentBlocks,
    settings,
  );

  const lastSyncDurationMillis = await getLastSyncDurationMillis();
  const repoStateByFullName = reposState.repoStateByFullName;
  const syncSuccessRepos = repos
    .filter((r) => {
      const repoState = repoStateByFullName.get(r.fullName());
      if (!repoState) {
        return false;
      }
      return (
        repoState.hasRecentSuccessfulSync(lastSyncDurationMillis) ||
        // chrome just restarted
        (repoState.lastSuccessfulSyncResult &&
          repoState.lastSuccessfulSyncResult.syncStartUnixMillis ==
            repoState.lastSyncResult.syncStartUnixMillis)
      );
    })
    .map((r) => repoStateByFullName.get(r.fullName()));
  const syncFailureRepos = repos
    .filter((r) => {
      const repoState = repoStateByFullName.get(r.fullName());
      if (!repoState) {
        return false;
      }
      if (syncSuccessRepos.some((v) => v.fullName === r.fullName())) {
        return false;
      }
      // #NOT_MATURE: is the following always true?
      return repoState.lastSyncResult.errorMsg;
    })
    .map((r) => repoStateByFullName.get(r.fullName()));
  const unsyncedRepos = repos.filter((r) => {
    return (
      !syncSuccessRepos.some((v) => v.fullName === r.fullName()) &&
      !syncFailureRepos.some((v) => v.fullName === r.fullName())
    );
  });

  maybeDisplayShowBlockedControls(
    syncSuccessRepos,
    reviewRequestBlocks,
    myPrBlocks,
    commentBlocks,
  );
  return populateFromState(
    syncSuccessRepos,
    syncFailureRepos,
    unsyncedRepos,
    myPrBlocks,
    reviewRequestBlocks,
    commentBlocks,
    settings,
  );
}

function maybeDisplayShowBlockedControls(
  syncSuccessRepos: RepoState[],
  reviewRequestBlocks: ReviewRequestBlock[],
  myPrBlocks: MyPrBlock[],
  commentBlocks: CommentBlock[],
) {
  let someBlockedOrSnoozed = false;
  someBlockedOrSnoozed = syncSuccessRepos
    .flatMap((r) => r.lastSuccessfulSyncResult.requestsForMyReview)
    .some((r) => reviewRequestBlocks.some((block) => r.isBlockedBy(block)));
  someBlockedOrSnoozed =
    someBlockedOrSnoozed ||
    syncSuccessRepos
      .flatMap((r) => r.lastSuccessfulSyncResult.myPRs)
      .some((r) => myPrBlocks.some((block) => r.isBlockedBy(block)));
  someBlockedOrSnoozed =
    someBlockedOrSnoozed ||
    syncSuccessRepos
      .flatMap((r) => r.lastSuccessfulSyncResult.comments)
      .some((r) => commentBlocks.some((block) => r.isBlockedBy(block)));
  if (someBlockedOrSnoozed) {
    (
      document.getElementById("showBlockedSpan") as HTMLInputElement
    ).style.visibility = "visible";
  }
}

const REVIEW_REQUSTED_SVG =
  '<svg aria-hidden="true" height="16" viewBox="0 0 16 16" width="16">\n' +
  '    <path d="M8 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z" fill="#9a6700"></path>\n' +
  "</svg>";

const COMMENTED_SVG =
  '<svg aria-hidden="true" height="16" viewBox="0 0 16 16" width="16">\n' +
  '    <path fill="#656d76" d="M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0 1 13.25 12H9.06l-2.573 2.573A1.458 1.458 0 0 1 4 13.543V12H2.75A1.75 1.75 0 0 1 1 10.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h4.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"></path>\n' +
  "</svg>";

const CHANGES_REQUSTED_SVG =
  '<svg aria-hidden="true" height="16" viewBox="0 0 16 16" width="16">\n' +
  '    <path fill="#656d76" d="M1.705 8.005a.75.75 0 0 1 .834.656 5.5 5.5 0 0 0 9.592 2.97l-1.204-1.204a.25.25 0 0 1 .177-.427h3.646a.25.25 0 0 1 .25.25v3.646a.25.25 0 0 1-.427.177l-1.38-1.38A7.002 7.002 0 0 1 1.05 8.84a.75.75 0 0 1 .656-.834ZM8 2.5a5.487 5.487 0 0 0-4.131 1.869l1.204 1.204A.25.25 0 0 1 4.896 6H1.25A.25.25 0 0 1 1 5.75V2.104a.25.25 0 0 1 .427-.177l1.38 1.38A7.002 7.002 0 0 1 14.95 7.16a.75.75 0 0 1-1.49.178A5.5 5.5 0 0 0 8 2.5Z"></path>\n' +
  "</svg>";

const APPROVED_SVG =
  '<svg aria-hidden="true" height="16" viewBox="0 0 16 16" width="16">\n' +
  '    <path fill="#1a7f37" d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"></path>\n' +
  "</svg>";

const SYNC_IN_PROGRESS_MSG = "Sync with GitHub in progress...";

async function populateFromState(
  syncSuccessRepos: RepoState[],
  syncFailureRepos: RepoState[],
  unsyncedRepos: Repo[],
  myPrBlocks: MyPrBlock[],
  reviewRequestBlocks: ReviewRequestBlock[],
  commentBlocks: CommentBlock[],
  settings: Settings,
) {
  document.getElementById(
    "myReviewRequestedNotMyTurnHeaderColumn",
  ).style.display = "none";

  const showBlocked = (
    document.getElementById("showBlocked") as HTMLInputElement
  ).checked;
  if (showBlocked) {
    myPrBlocks = [];
    reviewRequestBlocks = [];
    commentBlocks = [];
  }

  const repoWarnSection = document.getElementById("repoWarn");
  let badCredentialsErrorsOnly = false;
  if (syncFailureRepos.length > 0) {
    badCredentialsErrorsOnly = syncFailureRepos
      .map((repo) => {
        return repo.lastSyncResult.errorMsg;
      })
      .every((msg) => msg.endsWith(BAD_CREDENTIALS_GITHUB_ERROR_MSG));
    if (badCredentialsErrorsOnly) {
      repoWarnSection.innerHTML = SYNC_IN_PROGRESS_MSG;
    } else {
      repoWarnSection.innerHTML =
        "Attention! Couldn't sync with the following GitHub repos:<br/>" +
        syncFailureRepos
          .map((repo) => {
            const lastSyncErrorMsg = repo.lastSyncResult.errorMsg;
            let message = repo.fullName + " - " + lastSyncErrorMsg;
            if (
              lastSyncErrorMsg.includes(
                "You must grant your Personal Access token access to this organization",
              )
            ) {
              message +=
                ' <a href="https://github.com/settings/tokens" target="_blank">Configure SSO (authorize the access token)</a>.<br/> If that\'s already done just wait for a next sync with GitHub to complete - these are the errors messages for the last sync (see timestamp below).<br/>' +
                '<img src="configure-sso-instructions-later.png" style="border: 1px solid #555; width: 600px;" alt="Grant access to all the necessary organizations">';
            }
            return message;
          })
          .join(",<br/>");
    }
  } else {
    repoWarnSection.innerHTML = "";
  }

  const minSuccessSyncStartUnixMillis = Math.min(
    ...syncSuccessRepos.map(
      (r) => r.lastSuccessfulSyncResult.syncStartUnixMillis,
    ),
  );

  const repoListSection = document.getElementById("repoList");
  if (
    minSuccessSyncStartUnixMillis &&
    minSuccessSyncStartUnixMillis != Infinity
  ) {
    repoListSection.innerHTML =
      "Last sync with GitHub: " +
      new Date(minSuccessSyncStartUnixMillis).toLocaleString() +
      ".<br/>Repos monitored: " +
      syncSuccessRepos
        .map((repo) => repo.fullName)
        .sort()
        .join(", ") +
      ".";
  } else {
    if (unsyncedRepos.length > 0 || syncFailureRepos.length > 0) {
      repoListSection.innerHTML = "No recent successful syncs with GitHub yet.";
      if (!badCredentialsErrorsOnly) {
        repoListSection.innerHTML += " " + SYNC_IN_PROGRESS_MSG;
      }
    } else {
      repoListSection.innerHTML =
        "No repos currently monitored. Click 'Settings...' to select GitHub repositories to monitor.";
    }
  }
  if (unsyncedRepos.length > 0) {
    repoListSection.innerHTML =
      repoListSection.innerHTML +
      "<br/>Initial sync is in progress for repos: " +
      unsyncedRepos
        .map((repo) => repo.fullName())
        .sort()
        .join(", ") +
      ".";
  }

  // strictly speaking these are not necessarily requests for my review, see below
  const reviewRequests = syncSuccessRepos
    .flatMap((repo) => {
      return repo.lastSuccessfulSyncResult.requestsForMyReview.map((v) => {
        v.repoFullName = repo.fullName;
        return v;
      });
    })
    .filter((reviewRequest) =>
      reviewRequest.isMyTurn(reviewRequestBlocks, settings),
    );
  const sortedRequestsForMyReview = reviewRequests
    .filter((reviewRequest) => !reviewRequest.isTeamReviewRequest())
    .sort(
      (a, b) =>
        a.reviewRequestedAtUnixMillisOrZero() -
        b.reviewRequestedAtUnixMillisOrZero(),
    );
  const sortedRequestsForMyTeamReview = reviewRequests
    .filter((reviewRequest) => reviewRequest.isTeamReviewRequest())
    .sort((a, b) => {
      if (a.teamName < b.teamName) {
        return -1;
      }
      if (a.teamName > b.teamName) {
        return 1;
      }
      return 0;
    });

  const myPRs = syncSuccessRepos
    .flatMap((repo) => {
      return repo.lastSuccessfulSyncResult.myPRs.map((v) => {
        v.repoFullName = repo.fullName;
        return v;
      });
    })
    .filter((pr) => pr.isMyTurn(myPrBlocks, settings))
    .sort((a, b) => {
      if (a.repoFullName === b.repoFullName) {
        return a.pr.name.localeCompare(b.pr.name);
      } else {
        return a.repoFullName.localeCompare(b.repoFullName);
      }
    });

  const comments = syncSuccessRepos
    .flatMap((repo) => {
      return repo.lastSuccessfulSyncResult.comments.map((v) => {
        v.repoFullName = repo.fullName;
        return v;
      });
    })
    .filter((comment) => comment.isMyTurn(settings, commentBlocks))
    .sort((a, b) => {
      return a.createdAtUnixMillis - b.createdAtUnixMillis;
    });

  const myReviewRequestedTable = document.getElementById(
    "myReviewRequestedPrTable",
  ) as HTMLTableElement;
  deleteAllRows(myReviewRequestedTable);
  myReviewRequestedTable.style.display =
    sortedRequestsForMyReview.length == 0 ? "none" : "";

  const myTeamReviewRequestedTable = document.getElementById(
    "myTeamReviewRequestedPrTable",
  ) as HTMLTableElement;
  deleteAllRows(myTeamReviewRequestedTable);
  // don't even show h2 header if there are no team review requests:
  document.getElementById("teamReviewDiv").style.display =
    sortedRequestsForMyTeamReview.length == 0 ? "none" : "";

  const myPRsTable = document.getElementById("myPrTable") as HTMLTableElement;
  myPRsTable.style.display = myPRs.length == 0 ? "none" : "";
  deleteAllRows(myPRsTable);

  const commentsDiv = document.getElementById("commentsDiv");
  if (settings.ignoreCommentsMoreThanXDaysOld === 0) {
    commentsDiv.style.display = "none";
  }

  const commentsTable = document.getElementById(
    "commentsTable",
  ) as HTMLTableElement;
  commentsTable.style.display =
    settings.ignoreCommentsMoreThanXDaysOld === 0 || comments.length == 0
      ? "none"
      : "";
  deleteAllRows(commentsTable);

  // Iterate over the sortedRequestsForMyReview array and create a table row per entry
  for (let i = 0; i < sortedRequestsForMyReview.length; i++) {
    const reviewRequest = sortedRequestsForMyReview[i];

    let columnIndex = 0;
    const row = myReviewRequestedTable.insertRow();
    const repoCell = row.insertCell(columnIndex++);
    repoCell.innerHTML = reviewRequest.repoFullName;
    repoCell.className = "repoColumn";

    const prCell = row.insertCell(columnIndex++);
    prCell.innerHTML =
      "<a href = '" +
      reviewRequest.pr.url +
      "' target='_blank'>" +
      reviewRequest.pr.name +
      "</a>";

    const authorCell = row.insertCell(columnIndex++);
    authorCell.innerHTML = "@" + reviewRequest.pr.authorLogin;
    authorCell.className = "authorColumn";

    const hoursCell = row.insertCell(columnIndex++);
    if (reviewRequest.reviewRequestedAtUnixMillis()) {
      hoursCell.innerHTML =
        Math.floor(
          (Date.now() - reviewRequest.reviewRequestedAtUnixMillis()) /
            (1000 * 60 * 60),
        ) + "h";
    } else {
      hoursCell.innerHTML = "";
    }

    addSnoozeCell(
      row,
      reviewRequest,
      "snoozeMyReviewRequest" + i,
      columnIndex++,
      showBlocked,
    );

    if (
      reviewRequest.reasonNotIgnored ===
        ReasonNotIgnored.LIKELY_JUST_SINGLE_COMMENT ||
      reviewRequest.pr.isDraft
    ) {
      // #NOT_MATURE: partially duplicated below in my team review requests:
      const notMyTurnCell = row.insertCell(columnIndex++);
      notMyTurnCell.align = "center";
      // hide buttons to block if showing blocked (maybe better to hide the column instead)
      if (!showBlocked) {
        const notMyTurnImgId = "notMyTurnMyReviewRequest" + i;
        notMyTurnCell.innerHTML =
          '<img src="icons/xMark16.png" style="cursor: pointer; width: 12px;" id="' +
          notMyTurnImgId +
          '" alt="Not my turn" title="Not my turn / Ignore"/>';
        document
          .getElementById(notMyTurnImgId)
          .addEventListener("click", () => {
            addReviewRequestBlock(
              new ReviewRequestBlock(
                reviewRequest.pr.url,
                reviewRequest.reviewRequestedAtUnixMillisOrZero(),
              ),
            ).then(() => updatePopupPage());
          });
      }
      document.getElementById(
        "myReviewRequestedNotMyTurnHeaderColumn",
      ).style.display = "";
    }
  }

  // Iterate over the sortedRequestsForMyTeamReview array and create a table row per entry
  for (let i = 0; i < sortedRequestsForMyTeamReview.length; i++) {
    const reviewRequest = sortedRequestsForMyTeamReview[i];

    const row = myTeamReviewRequestedTable.insertRow();
    const repoCell = row.insertCell(0);
    repoCell.innerHTML = reviewRequest.repoFullName;
    repoCell.className = "repoColumn";

    const teamCell = row.insertCell(1);
    teamCell.innerHTML = "@" + reviewRequest.teamName;
    teamCell.className = "teamColumn";

    const prCell = row.insertCell(2);
    prCell.innerHTML =
      "<a href = '" +
      reviewRequest.pr.url +
      "' target='_blank'>" +
      reviewRequest.pr.name +
      "</a>";

    const authorCell = row.insertCell(3);
    authorCell.innerHTML = "@" + reviewRequest.pr.authorLogin;
    authorCell.className = "authorColumn";

    addSnoozeCell(
      row,
      reviewRequest,
      "snoozeMyTeamReviewRequest" + i,
      4,
      showBlocked,
    );

    // #NOT_MATURE: partially duplicated above in my review requests:
    const notMyTurnCell = row.insertCell(5);
    notMyTurnCell.align = "center";
    // hide buttons to block if showing blocked (maybe better to hide the column instead)
    if (!showBlocked) {
      const notMyTurnImgId = "notMyTurnMyTeamReviewRequest" + i;
      notMyTurnCell.innerHTML =
        '<img src="icons/xMark16.png" style="cursor: pointer; width: 12px;" id="' +
        notMyTurnImgId +
        '" alt="Not my turn" title="Not my turn / Ignore"/>';
      document.getElementById(notMyTurnImgId).addEventListener("click", () => {
        addReviewRequestBlock(
          new ReviewRequestBlock(
            reviewRequest.pr.url,
            reviewRequest.reviewRequestedAtUnixMillisOrZero(),
          ),
        ).then(() => updatePopupPage());
      });
    }
  }

  // Iterate over the myPRs array and create rows for each entry
  for (let i = 0; i < myPRs.length; i++) {
    const myPR = myPRs[i];

    const row = myPRsTable.insertRow(i + 1); // Insert rows starting from index 1
    row.id = "myPrRow" + i;

    const repoCell = row.insertCell(0);
    repoCell.innerHTML = myPR.repoFullName;
    repoCell.className = "repoColumn";

    const prCell = row.insertCell(1);
    prCell.innerHTML =
      "<a href = '" +
      myPR.pr.url +
      "' target='_blank'>" +
      myPR.pr.name +
      "</a>";

    const statusCell = row.insertCell(2);

    let hasReviewRequested = false;
    let hasCommented = false;
    let hasChangesRequested = false;
    let hasApproved = false;
    myPR.reviewerStates.forEach((reviewerState) => {
      if (reviewerState.state === ReviewState.REQUESTED) {
        hasReviewRequested = true;
      } else if (reviewerState.state === ReviewState.COMMENTED) {
        hasCommented = true;
      } else if (reviewerState.state === ReviewState.CHANGES_REQUESTED) {
        hasChangesRequested = true;
      } else if (reviewerState.state === ReviewState.APPROVED) {
        hasApproved = true;
      }
    });

    statusCell.innerHTML = "";
    statusCell.align = "center";

    if (hasApproved) {
      statusCell.innerHTML += APPROVED_SVG;
    }
    if (hasCommented) {
      statusCell.innerHTML += COMMENTED_SVG;
    }
    if (hasChangesRequested) {
      statusCell.innerHTML += CHANGES_REQUSTED_SVG;
    }
    if (hasReviewRequested) {
      statusCell.innerHTML += REVIEW_REQUSTED_SVG;
    }

    const notMyTurnCell = row.insertCell(3);
    notMyTurnCell.align = "center";
    notMyTurnCell.className = "notMyTurnColumn";
    // hide buttons to block if showing blocked (maybe better to hide the column instead)
    if (!showBlocked) {
      notMyTurnCell.innerHTML =
        '<img src="icons/xMark16.png" style="cursor: pointer; width: 12px;" id="notMyTurn' +
        i +
        '" alt="Not my turn" title="Not my turn / Ignore"/>';
      document.getElementById("notMyTurn" + i).addEventListener("click", () => {
        if (
          !confirm(
            "That would remove PR from the list until there is a new review ready. Sure it's not your turn now?",
          )
        ) {
          return;
        }
        addMyPrBlock(
          new MyPrBlock(
            myPR.pr.url,
            // should never be null here:
            myPR.getLastReviewSubmittedUnixMillis(),
          ),
        ).then(() => updatePopupPage());
      });
    }
  }

  // Iterate over the comments array and create rows for each entry
  for (let i = 0; i < comments.length; i++) {
    const comment = comments[i];

    const row = commentsTable.insertRow(i + 1); // Insert rows starting from index 1
    row.id = "myPrRow" + i;

    const repoCell = row.insertCell(0);
    repoCell.innerHTML = comment.repoFullName;
    repoCell.className = "repoColumn";

    const prCell = row.insertCell(1);
    prCell.className = "prColumn";
    prCell.innerHTML = comment.pr.name;

    const authorCell = row.insertCell(2);
    authorCell.innerHTML = "@" + comment.authorLogin;
    authorCell.className = "authorColumn";

    const commentCell = row.insertCell(3);
    commentCell.className = "commentColumn";
    let text = comment.body;
    if (text.length > 70) {
      text = text.substring(0, 70) + "...";
    }
    text = '"' + text + '"';
    commentCell.innerHTML =
      "<a href = '" + comment.url + "' target='_blank'>" + text + "</a>";

    const hoursCell = row.insertCell(4);
    hoursCell.innerHTML =
      Math.floor(
        (Date.now() - comment.createdAtUnixMillis) / (1000 * 60 * 60),
      ) + "h";

    const notMyTurnCell = row.insertCell(5);
    notMyTurnCell.align = "center";
    notMyTurnCell.className = "notMyTurnColumn";
    // hide buttons to block if showing blocked (maybe better to hide the column instead)
    if (!showBlocked) {
      notMyTurnCell.innerHTML =
        '<img src="icons/xMark16.png" style="cursor: pointer; width: 12px;" id="blockComment' +
        i +
        '" alt="Not my turn" title="Not my turn / Ignore"/>';
      document
        .getElementById("blockComment" + i)
        .addEventListener("click", () => {
          addCommentBlock(new CommentBlock(comment.url)).then(() =>
            updatePopupPage(),
          );
        });
    }
  }
}

function addSnoozeCell(
  row: HTMLTableRowElement,
  reviewRequest: ReviewRequest,
  snoozeImgId: string,
  cellIndex: number,
  showBlocked: boolean,
) {
  const snoozeCell = row.insertCell(cellIndex);
  snoozeCell.align = "center";
  if (showBlocked) {
    // hide buttons to snooze if showing snoozed/blocked (maybe better to hide the column instead)
    return;
  }
  snoozeCell.innerHTML =
    '<img src="icons/snooze256.png" style="cursor: pointer; width: 20px;" id="' +
    snoozeImgId +
    '" alt="Snooze till tomorrow" title="I\'ll take a look tomorrow"/>';
  document.getElementById(snoozeImgId).addEventListener("click", () => {
    // Quick turnaround is super important in code review so hardcode "till 4am tomorrow"
    const expireDate = new Date();
    expireDate.setHours(28);
    addReviewRequestBlock(
      new ReviewRequestBlock(
        reviewRequest.pr.url,
        reviewRequest.reviewRequestedAtUnixMillisOrZero(),
        expireDate.getTime(),
      ),
    ).then(() => updatePopupPage());
  });
}

function deleteAllRows(htmlTableElement: HTMLTableElement) {
  while (htmlTableElement.rows.length > 1) {
    htmlTableElement.deleteRow(1);
  }
}
