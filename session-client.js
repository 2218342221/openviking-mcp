const SESSION_TASK_POLL_INTERVAL_MS = 5_000;
const SESSION_TASK_POLL_MAX_ATTEMPTS = 240;

function getErrorMessage(err) {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string") return err;
  return String(err);
}

function isNotFoundError(err) {
  const message = getErrorMessage(err).toLowerCase();
  return (
    message.includes("[not_found]") ||
    message.includes("not found") ||
    message.includes("http 404")
  );
}

function getTaskStatus(task) {
  if (!task || typeof task !== "object") return "";
  if (typeof task.status === "string") return task.status.toLowerCase();
  return "";
}

export class OpenVikingSessionClient {
  constructor(requestFn) {
    this.request = requestFn;
    this.pendingCommitCleanup = new Set();
  }

  async createSession() {
    const result = await this.request("/api/v1/sessions", {
      method: "POST",
      body: JSON.stringify({}),
    });
    return result.session_id;
  }

  async addSessionMessage(sessionId, role, content) {
    await this.request(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/messages`,
      {
        method: "POST",
        body: JSON.stringify({ role, content }),
      }
    );
  }

  async getSession(sessionId) {
    return this.request(`/api/v1/sessions/${encodeURIComponent(sessionId)}`, {
      method: "GET",
    });
  }

  async commitSession(sessionId) {
    return this.request(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/commit`,
      { method: "POST", body: JSON.stringify({}) }
    );
  }

  async getTask(taskId) {
    return this.request(`/api/v1/tasks/${encodeURIComponent(taskId)}`, {
      method: "GET",
    });
  }

  async deleteSession(sessionId) {
    await this.request(`/api/v1/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
    });
  }

  scheduleCleanupAfterCommit(sessionId, taskId, reason = "") {
    if (!sessionId || !taskId) return false;

    const cleanupKey = `${sessionId}:${taskId}`;
    if (this.pendingCommitCleanup.has(cleanupKey)) {
      return false;
    }
    this.pendingCommitCleanup.add(cleanupKey);

    const finish = () => {
      this.pendingCommitCleanup.delete(cleanupKey);
    };

    const runAttempt = async (attempt) => {
      let task;
      try {
        task = await this.getTask(taskId);
      } catch (err) {
        if (attempt >= SESSION_TASK_POLL_MAX_ATTEMPTS) {
          console.error(
            `[openviking-memory] Commit cleanup exhausted at get_task for session ${sessionId}, task ${taskId}${reason ? ` (${reason})` : ""}: ${getErrorMessage(err)}`
          );
          finish();
          return;
        }
        setTimeout(
          () => void runAttempt(attempt + 1),
          SESSION_TASK_POLL_INTERVAL_MS
        );
        return;
      }

      const status = getTaskStatus(task);
      if (status === "pending" || status === "running" || status === "accepted" || status === "") {
        if (attempt >= SESSION_TASK_POLL_MAX_ATTEMPTS) {
          console.error(
            `[openviking-memory] Commit cleanup exhausted waiting task completion for session ${sessionId}, task ${taskId}${reason ? ` (${reason})` : ""}. Last status: ${status || "unknown"}`
          );
          finish();
          return;
        }
        setTimeout(
          () => void runAttempt(attempt + 1),
          SESSION_TASK_POLL_INTERVAL_MS
        );
        return;
      }

      if (status !== "completed") {
        console.error(
          `[openviking-memory] Commit task ended with non-completed status for session ${sessionId}, task ${taskId}${reason ? ` (${reason})` : ""}: ${status}`
        );
      }

      try {
        await this.deleteSession(sessionId);
        finish();
      } catch (err) {
        if (isNotFoundError(err)) {
          finish();
          return;
        }
        if (attempt >= SESSION_TASK_POLL_MAX_ATTEMPTS) {
          console.error(
            `[openviking-memory] Commit cleanup exhausted at delete_session for session ${sessionId}, task ${taskId}${reason ? ` (${reason})` : ""}: ${getErrorMessage(err)}`
          );
          finish();
          return;
        }
        setTimeout(
          () => void runAttempt(attempt + 1),
          SESSION_TASK_POLL_INTERVAL_MS
        );
      }
    };

    setTimeout(() => void runAttempt(1), SESSION_TASK_POLL_INTERVAL_MS);
    return true;
  }
}
