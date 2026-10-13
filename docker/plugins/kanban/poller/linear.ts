import {
  lastEnteredState,
  type ProjectConfig,
  parseProjectConfig,
  type Comment,
  type Issue,
  type StateEntry,
  type TicketComment,
  type TicketData,
  type TimedComment,
} from "./select.ts";

const ENDPOINT = "https://api.linear.app/graphql";
const REQUEST_TIMEOUT_MS = 30_000;
const PAGE_SIZE = 50;
const COMMENT_PAGE_SIZE = 100;
const HISTORY_PAGE_SIZE = 100;
const MAX_PAGES = 20;

export class LinearError extends Error {}

interface Connection<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

interface RawIssue {
  id: string;
  identifier: string;
  createdAt: string;
  state: { name: string };
  labels: { nodes: { name: string }[] };
  branchName: string;
  reactions: { id: string; emoji: string; createdAt: string; user: { id: string } | null }[];
  project: { description: string | null; content: string | null } | null;
}

interface RawComment {
  id: string;
  body: string;
  createdAt: string;
  parent: { id: string } | null;
  user: { id: string } | null;
  externalUser: { id: string } | null;
  botActor: { id: string } | null;
  syncedWith: unknown[] | null;
  issue: { id: string; identifier: string } | null;
  reactions: { emoji: string; user: { id: string } | null }[];
}

const ISSUE_FIELDS = `
  id identifier createdAt branchName
  state { name }
  labels(first: 50) { nodes { name } }
  project { description content }
  reactions { id emoji createdAt user { id } }
`;

export interface Ids {
  teamId: string;
  states: Map<string, string>;
  labels: Map<string, string>;
}

export class LinearClient {
  constructor(
    private readonly apiKey: string,
    private readonly team: string,
    private readonly projectsRoot: string | null = null,
  ) {}

  private async request<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    let response: Response;
    try {
      response = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: this.apiKey },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new LinearError(`request failed: ${(error as Error).name}`);
    }
    let payload: { data?: T; errors?: { message: string }[] };
    try {
      payload = (await response.json()) as typeof payload;
    } catch {
      throw new LinearError(`HTTP ${response.status}: response is not JSON`);
    }
    if (payload.errors?.length) {
      throw new LinearError(`GraphQL error (HTTP ${response.status}): ${payload.errors[0].message}`);
    }
    if (!response.ok || !payload.data) throw new LinearError(`HTTP ${response.status}`);
    return payload.data;
  }

  private async paginate<T>(
    query: string,
    variables: Record<string, unknown>,
    pick: (data: any) => Connection<T>,
  ): Promise<T[]> {
    const all: T[] = [];
    let after: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const connection = pick(await this.request(query, { ...variables, after }));
      all.push(...connection.nodes);
      if (!connection.pageInfo.hasNextPage) return all;
      after = connection.pageInfo.endCursor;
    }
    throw new LinearError(`pagination exceeded ${MAX_PAGES} pages`);
  }

  async viewerId(): Promise<string> {
    const data = await this.request<{ viewer: { id: string } }>("query { viewer { id } }");
    return data.viewer.id;
  }

  /** Resolves state and label ids by exact name. Throws listing every missing name. */
  async resolveIds(stateNames: string[], labelNames: string[]): Promise<Ids> {
    const teams = await this.request<{ teams: { nodes: { id: string }[] } }>(
      `query($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id } } }`,
      { key: this.team },
    );
    const teamId = teams.teams.nodes[0]?.id;
    if (!teamId) throw new LinearError(`team ${this.team} not found`);

    const states = await this.request<{ workflowStates: { nodes: { id: string; name: string }[] } }>(
      `query($teamId: ID!) { workflowStates(first: 100, filter: { team: { id: { eq: $teamId } } }) { nodes { id name } } }`,
      { teamId },
    );
    const labels = await this.request<{ issueLabels: { nodes: { id: string; name: string }[] } }>(
      `query($teamId: ID!) { issueLabels(first: 250, filter: { or: [{ team: { id: { eq: $teamId } } }, { team: { null: true } }] }) { nodes { id name } } }`,
      { teamId },
    );
    const stateIds = new Map(states.workflowStates.nodes.map((s) => [s.name, s.id]));
    const labelIds = new Map(labels.issueLabels.nodes.map((l) => [l.name, l.id]));
    const missing = [
      ...stateNames.filter((n) => !stateIds.has(n)).map((n) => `state "${n}"`),
      ...labelNames.filter((n) => !labelIds.has(n)).map((n) => `label "${n}"`),
    ];
    if (missing.length > 0) throw new LinearError(`missing in Linear: ${missing.join(", ")}`);
    return { teamId, states: stateIds, labels: labelIds };
  }

  private toIssue(raw: RawIssue): Issue {
    const projectText = [raw.project?.description, raw.project?.content].filter(Boolean).join("\n");
    const projectConfig = parseProjectConfig(projectText, this.projectsRoot);
    return {
      id: raw.id,
      identifier: raw.identifier,
      createdAt: raw.createdAt,
      state: raw.state.name,
      labels: raw.labels.nodes.map((l) => l.name),
      projectPath: "error" in projectConfig ? null : projectConfig.path,
      projectConfig,
      branchName: raw.branchName,
      reactions: (raw.reactions ?? []).map((r) => ({
        id: r.id,
        emoji: r.emoji,
        createdAt: r.createdAt,
        userId: r.user?.id ?? null,
      })),
    };
  }

  /** Issues in a state; with `updatedSinceIso`, only those updated after that time. */
  async issuesInState(stateName: string, updatedSinceIso?: string): Promise<Issue[]> {
    const raw = await this.paginate<RawIssue>(
      `query($key: String!, $state: String!, ${updatedSinceIso ? "$since: DateTimeOrDuration, " : ""}$after: String) {
        issues(first: ${PAGE_SIZE}, after: $after, filter: { team: { key: { eq: $key } }, state: { name: { eq: $state } }${
          updatedSinceIso ? ", updatedAt: { gt: $since }" : ""
        } }) {
          nodes { ${ISSUE_FIELDS} }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { key: this.team, state: stateName, ...(updatedSinceIso ? { since: updatedSinceIso } : {}) },
      (data) => data.issues,
    );
    return raw.map((r) => this.toIssue(r));
  }

  async issue(identifier: string): Promise<Issue> {
    const data = await this.request<{ issue: RawIssue }>(
      `query($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`,
      { id: identifier },
    );
    return this.toIssue(data.issue);
  }

  /** The issue, or null when the identifier does not exist. */
  async findIssue(identifier: string): Promise<Issue | null> {
    try {
      return await this.issue(identifier);
    } catch (error) {
      if (error instanceof LinearError && /not found/i.test(error.message)) return null;
      throw error;
    }
  }

  /** `repo:` and `path:` of every project of the team that has a valid description. */
  async projectConfigs(): Promise<ProjectConfig[]> {
    const projects = await this.paginate<{ description: string | null; content: string | null }>(
      `query($key: String!, $after: String) {
        teams(filter: { key: { eq: $key } }) {
          nodes {
            projects(first: ${PAGE_SIZE}, after: $after) {
              nodes { description content }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      }`,
      { key: this.team },
      (data) => data.teams.nodes[0]?.projects ?? { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    );
    const configs = projects
      .map((p) => parseProjectConfig([p.description, p.content].filter(Boolean).join("\n"), this.projectsRoot))
      .filter((c): c is ProjectConfig => !("error" in c));
    return [...new Map(configs.map((c) => [c.path, c])).values()];
  }

  /** Comments oldest first, with their author's user id (the poller's own comments carry its API user id). */
  async issueComments(identifier: string): Promise<TimedComment[]> {
    const raw = await this.paginate<{ body: string; createdAt: string; user: { id: string } | null }>(
      `query($id: String!, $after: String) {
        issue(id: $id) {
          comments(first: ${COMMENT_PAGE_SIZE}, after: $after) {
            nodes { body createdAt user { id } }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { id: identifier },
      (data) => data.issue.comments,
    );
    return raw.map((c) => ({ body: c.body, createdAt: c.createdAt, authorId: c.user?.id ?? null }));
  }

  /** Everything the agent may read about a ticket: details, attachments, all comments, state history. */
  async ticketData(identifier: string): Promise<TicketData> {
    const detail = await this.request<{
      issue: {
        identifier: string;
        title: string;
        description: string | null;
        url: string;
        state: { name: string };
        labels: { nodes: { name: string }[] };
        project: { name: string } | null;
        attachments: { nodes: { title: string | null; url: string }[] };
      };
    }>(
      `query($id: String!) {
        issue(id: $id) {
          identifier title description url
          state { name }
          labels(first: 50) { nodes { name } }
          project { name }
          attachments(first: 50) { nodes { title url } }
        }
      }`,
      { id: identifier },
    );
    const comments = await this.paginate<{
      id: string;
      body: string;
      createdAt: string;
      parent: { id: string } | null;
      user: { id: string; name: string } | null;
      externalUser: { name: string } | null;
      botActor: { name: string | null } | null;
    }>(
      `query($id: String!, $after: String) {
        issue(id: $id) {
          comments(first: ${COMMENT_PAGE_SIZE}, after: $after) {
            nodes {
              id body createdAt
              parent { id }
              user { id name }
              externalUser { name }
              botActor { name }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { id: identifier },
      (data) => data.issue.comments,
    );
    const history = await this.paginate<{
      createdAt: string;
      fromState: { name: string } | null;
      toState: { name: string } | null;
    }>(
      `query($id: String!, $after: String) {
        issue(id: $id) {
          history(first: ${HISTORY_PAGE_SIZE}, after: $after) {
            nodes { createdAt fromState { name } toState { name } }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { id: identifier },
      (data) => data.issue.history,
    );
    const raw = detail.issue;
    return {
      identifier: raw.identifier,
      title: raw.title,
      description: raw.description,
      state: raw.state.name,
      labels: raw.labels.nodes.map((l) => l.name),
      projectName: raw.project?.name ?? null,
      url: raw.url,
      attachments: raw.attachments.nodes.map((a) => ({ title: a.title ?? "", url: a.url })),
      comments: comments.map(
        (c): TicketComment => ({
          id: c.id,
          parentId: c.parent?.id ?? null,
          authorName: c.user?.name ?? c.externalUser?.name ?? c.botActor?.name ?? null,
          authorUserId: c.user?.id ?? null,
          createdAt: c.createdAt,
          body: c.body,
        }),
      ),
      stateHistory: history
        .filter((h) => h.toState !== null)
        .map((h) => ({ createdAt: h.createdAt, from: h.fromState?.name ?? null, to: h.toState!.name })),
    };
  }

  /** Time the issue last moved into `stateName`, from its history; null if never. */
  async lastEnteredStateAt(identifier: string, stateName: string): Promise<string | null> {
    const history = await this.paginate<{ createdAt: string; toState: { name: string } | null }>(
      `query($id: String!, $after: String) {
        issue(id: $id) {
          history(first: ${HISTORY_PAGE_SIZE}, after: $after) {
            nodes { createdAt toState { name } }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { id: identifier },
      (data) => data.issue.history,
    );
    return lastEnteredState(
      history.map((h): StateEntry => ({ createdAt: h.createdAt, toState: h.toState?.name ?? null })),
      stateName,
    );
  }

  async commentsSince(sinceIso: string): Promise<Comment[]> {
    const raw = await this.paginate<RawComment>(
      `query($key: String!, $since: DateTimeOrDuration!, $after: String) {
        comments(first: ${COMMENT_PAGE_SIZE}, after: $after, filter: { createdAt: { gt: $since }, issue: { team: { key: { eq: $key } } } }) {
          nodes {
            id body createdAt
            parent { id }
            user { id }
            externalUser { id }
            botActor { id }
            syncedWith { service }
            issue { id identifier }
            reactions { emoji user { id } }
          }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { key: this.team, since: sinceIso },
      (data) => data.comments,
    );
    return raw
      .filter((c) => c.issue !== null)
      .map((c) => ({
        id: c.id,
        body: c.body,
        createdAt: c.createdAt,
        parentId: c.parent?.id ?? null,
        userId: c.user?.id ?? null,
        externalUserId: c.externalUser?.id ?? null,
        botActorId: c.botActor?.id ?? null,
        synced: (c.syncedWith?.length ?? 0) > 0,
        issueId: c.issue!.id,
        issueIdentifier: c.issue!.identifier,
        reactions: (c.reactions ?? []).map((r) => ({ emoji: r.emoji, userId: r.user?.id ?? null })),
      }));
  }

  /** Returns the new comment's id. */
  async addComment(issueId: string, body: string, parentId?: string): Promise<string> {
    const data = await this.request<{ commentCreate: { comment: { id: string } } }>(
      `mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }`,
      { input: { issueId, body, ...(parentId ? { parentId } : {}) } },
    );
    return data.commentCreate.comment.id;
  }

  async react(commentId: string, emoji: string): Promise<void> {
    await this.request(
      `mutation($input: ReactionCreateInput!) { reactionCreate(input: $input) { success } }`,
      { input: { commentId, emoji } },
    );
  }

  async reactToIssue(issueId: string, emoji: string): Promise<void> {
    await this.request(
      `mutation($input: ReactionCreateInput!) { reactionCreate(input: $input) { success } }`,
      { input: { issueId, emoji } },
    );
  }

  async deleteReaction(id: string): Promise<void> {
    await this.request(`mutation($id: String!) { reactionDelete(id: $id) { success } }`, { id });
  }

  async updateIssue(
    issueId: string,
    change: { stateId?: string; addLabelIds?: string[]; removeLabelIds?: string[] },
  ): Promise<void> {
    const input: Record<string, unknown> = {};
    if (change.stateId) input.stateId = change.stateId;
    if (change.addLabelIds?.length) input.addedLabelIds = change.addLabelIds;
    if (change.removeLabelIds?.length) input.removedLabelIds = change.removeLabelIds;
    await this.request(
      `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
      { id: issueId, input },
    );
  }
}
