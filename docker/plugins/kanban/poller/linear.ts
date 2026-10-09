import { parseProjectConfig, parseProjectPath, type Comment, type Issue, type TimedComment } from "./select.ts";

const ENDPOINT = "https://api.linear.app/graphql";
const REQUEST_TIMEOUT_MS = 30_000;
const PAGE_SIZE = 50;
const COMMENT_PAGE_SIZE = 100;
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
    return {
      id: raw.id,
      identifier: raw.identifier,
      createdAt: raw.createdAt,
      state: raw.state.name,
      labels: raw.labels.nodes.map((l) => l.name),
      projectPath: projectText ? parseProjectPath(projectText) : null,
      projectConfig: parseProjectConfig(projectText),
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

  async issueComments(identifier: string): Promise<TimedComment[]> {
    return this.paginate<TimedComment>(
      `query($id: String!, $after: String) {
        issue(id: $id) {
          comments(first: ${COMMENT_PAGE_SIZE}, after: $after) {
            nodes { body createdAt }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { id: identifier },
      (data) => data.issue.comments,
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
