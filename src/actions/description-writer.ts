/**
 * Framework-free subreddit description writer that routes around a Devvit
 * library defect.
 *
 * `Subreddit.updateSettings({ description })` in @devvit/reddit 0.14.x–0.15.x
 * copies the full description verbatim into `publicDescription`
 * (`publicDescription: description ?? ''` in models/Subreddit.js). Reddit caps
 * public_description at 500 characters, so any subreddit whose description is
 * longer — including every description carrying the marker block — is rejected
 * wholesale with `TOO_LONG: public_description`. The fix is not shipped in
 * @devvit/reddit through 0.15.2-next (verified 2026-10-31).
 *
 * This seam instead uses the raw Reddit API plugins:
 *  - SubredditAbout reads the live description AND public_description;
 *  - SiteAdmin writes the description back while passing the existing
 *    public_description through byte-for-byte, with every other field sourced
 *    from the same About payload so nothing else can change.
 */

/** Subset of SubredditAboutResponse.data used to build the write. */
export interface SubredditAboutData {
  readonly id?: string | undefined;
  readonly displayName?: string | undefined;
  readonly title?: string | undefined;
  readonly subredditType?: string | undefined;
  readonly over18?: boolean | undefined;
  readonly originalContentTagEnabled?: boolean | undefined;
  readonly submissionType?: string | undefined;
  readonly description?: string | undefined;
  readonly publicDescription?: string | undefined;
  readonly acceptFollowers?: boolean | undefined;
  readonly allOriginalContent?: boolean | undefined;
  readonly allowChatPostCreation?: boolean | undefined;
  readonly allowDiscovery?: boolean | undefined;
  readonly allowGalleries?: boolean | undefined;
  readonly allowImages?: boolean | undefined;
  readonly disableContributorRequests?: boolean | undefined;
  readonly freeFormReports?: boolean | undefined;
  readonly headerTitle?: string | undefined;
  readonly hideAds?: boolean | undefined;
  readonly isCrosspostableSubreddit?: boolean | undefined;
  readonly allowPolls?: boolean | undefined;
  readonly allowPredictionContributors?: boolean | undefined;
  readonly allowPredictions?: boolean | undefined;
  readonly allowPredictionsTournament?: boolean | undefined;
  readonly allowTalks?: boolean | undefined;
  readonly allowVideos?: boolean | undefined;
  readonly restrictCommenting?: boolean | undefined;
  readonly restrictPosting?: boolean | undefined;
  readonly shouldArchivePosts?: boolean | undefined;
  readonly spoilersEnabled?: boolean | undefined;
  readonly spamComments?: string | undefined;
  readonly spamLinks?: string | undefined;
  readonly spamSelfposts?: string | undefined;
  readonly submitLinkLabel?: string | undefined;
  readonly submitText?: string | undefined;
  readonly submitTextLabel?: string | undefined;
  readonly suggestedCommentSort?: string | undefined;
  readonly keyColor?: string | undefined;
  readonly showMedia?: boolean | undefined;
  readonly showMediaPreview?: boolean | undefined;
  readonly wikimode?: string | undefined;
  readonly [key: string]: unknown;
}

export interface RawSubredditsPlugin {
  SubredditAbout(
    request: Record<string, unknown>,
    metadata?: unknown
  ): Promise<{
    readonly data?: SubredditAboutData | undefined;
  }>;
  SiteAdmin(request: Record<string, unknown>, metadata?: unknown): Promise<unknown>;
}

export interface DescriptionWriterDeps {
  readonly subreddits: RawSubredditsPlugin;
  /** Request metadata carrying the actor's subreddit context, forwarded to every plugin call. */
  readonly metadata?: unknown;
}

// These are the values returned by Reddit's submissionType field and accepted
// verbatim by @devvit/reddit's asAllowedPostType helper.
const ALLOWED_POST_TYPES = new Set(['any', 'link', 'self', 'other']);
const SUBREDDIT_TYPES = new Set([
  'public',
  'private',
  'restricted',
  'gold_restricted',
  'gold_only',
  'archived',
  'employees_only',
  'user',
]);

function bool(data: SubredditAboutData, key: keyof SubredditAboutData): boolean {
  return data[key] === true;
}

function str(data: SubredditAboutData, key: keyof SubredditAboutData): string {
  const value = data[key];
  return typeof value === 'string' ? value : '';
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' ? value : fallback;
}

function requiredString(data: SubredditAboutData, key: keyof SubredditAboutData): string {
  const value = data[key];
  if (typeof value !== 'string') {
    throw new Error(`subreddit About response missing ${String(key)}`);
  }
  return value;
}

/** The About request every field of the write is sourced from. */
function aboutRequest(subredditName: string): Record<string, unknown> {
  // BasicSubredditRequest's only field is `subreddit`.
  return { subreddit: subredditName };
}

/**
 * Build a SiteAdmin request from live About data that changes only the
 * description: `publicDescription` passes the existing value through so
 * Reddit never re-derives (and rejects) it.
 */
export function buildDescriptionOnlyRequest(
  data: SubredditAboutData,
  nextDescription: string
): Record<string, unknown> {
  const name = typeof data.displayName === 'string' ? data.displayName : '';
  const id = typeof data.id === 'string' ? data.id : '';
  if (!name || !id) {
    throw new Error('subreddit About response missing id or displayName');
  }
  const title = typeof data.title === 'string' && data.title ? data.title : name;
  const rawType =
    typeof data.subredditType === 'string' ? data.subredditType.toLowerCase() : 'public';
  const type = SUBREDDIT_TYPES.has(rawType) ? rawType : 'public';
  const rawPostType = str(data, 'submissionType') || 'any';
  const linkType = ALLOWED_POST_TYPES.has(rawPostType) ? rawPostType : 'any';
  return {
    sr: id,
    name,
    title,
    type,
    linkType,
    description: nextDescription,
    // An omitted public description is unknown, not an empty description. Do
    // not turn an incomplete About response into a destructive write.
    publicDescription: requiredString(data, 'publicDescription'),
    over18: data.over18 === true,
    acceptFollowers: bool(data, 'acceptFollowers'),
    allOriginalContent: bool(data, 'allOriginalContent'),
    allowChatPostCreation: bool(data, 'allowChatPostCreation'),
    allowDiscovery: bool(data, 'allowDiscovery'),
    allowGalleries: bool(data, 'allowGalleries'),
    allowImages: bool(data, 'allowImages'),
    allowPolls: bool(data, 'allowPolls'),
    allowPostCrossposts: bool(data, 'isCrosspostableSubreddit'),
    disableContributorRequests: bool(data, 'disableContributorRequests'),
    freeFormReports: bool(data, 'freeFormReports'),
    headerTitle: str(data, 'headerTitle'),
    keyColor: str(data, 'keyColor'),
    originalContentTagEnabled: bool(data, 'originalContentTagEnabled'),
    hideAds: bool(data, 'hideAds'),
    allowPredictionContributors: bool(data, 'allowPredictionContributors'),
    allowPredictions: bool(data, 'allowPredictions'),
    allowPredictionsTournament: bool(data, 'allowPredictionsTournament'),
    allowTalks: bool(data, 'allowTalks'),
    allowVideos: bool(data, 'allowVideos'),
    restrictCommenting: bool(data, 'restrictCommenting'),
    restrictPosting: bool(data, 'restrictPosting'),
    shouldArchivePosts: bool(data, 'shouldArchivePosts'),
    spoilersEnabled: bool(data, 'spoilersEnabled'),
    spamComments: str(data, 'spamComments'),
    spamLinks: str(data, 'spamLinks'),
    spamSelfposts: str(data, 'spamSelfposts'),
    submitLinkLabel: str(data, 'submitLinkLabel'),
    submitText: str(data, 'submitText'),
    submitTextLabel: str(data, 'submitTextLabel'),
    suggestedCommentSort: str(data, 'suggestedCommentSort'),
    wikimode: str(data, 'wikimode'),
    // The Reddit API requires every field to be present; values the About
    // payload does not carry (spam thresholds, wikimode, crowd control, …)
    // match the defaults the Devvit library itself hardcodes, so the write
    // cannot alter those settings. Fields the payload DOES carry are passed
    // through, not defaulted — defaulting them would silently reset live
    // settings (e.g. collapseDeletedComments, commentScoreHideMins).
    adminOverrideSpamComments: false,
    adminOverrideSpamLinks: false,
    adminOverrideSpamSelfposts: false,
    allowTop: false,
    banEvasionThreshold: 0,
    collapseDeletedComments: bool(data, 'collapseDeletedComments'),
    commentScoreHideMins: numberOr(data.commentScoreHideMins, 0),
    crowdControlChatLevel: 0,
    crowdControlFilter: false,
    crowdControlLevel: 0,
    crowdControlMode: false,
    crowdControlPostLevel: 0,
    excludeBannedModqueue: false,
    gRecaptchaResponse: '',
    hatefulContentThresholdAbuse: 0,
    hatefulContentThresholdIdentity: 0,
    modmailHarassmentFilterEnabled: false,
    newPinnedPostPnsEnabled: false,
    predictionLeaderboardEntryType: 0,
    showMedia: bool(data, 'showMedia'),
    showMediaPreview: bool(data, 'showMediaPreview'),
    toxicityThresholdChatLevel: 0,
    userFlairPnsEnabled: false,
    welcomeMessageEnabled: false,
    welcomeMessageText: '',
    wikiEditAge: 0,
    wikiEditKarma: 0,
  };
}

/**
 * Read the live description (About), splice-safe for the caller: this seam
 * only reads and writes; marker policy stays in description.ts.
 */
export async function readSubredditDescription(
  deps: DescriptionWriterDeps,
  subredditName: string
): Promise<string | undefined> {
  try {
    const response = await deps.subreddits.SubredditAbout(
      aboutRequest(subredditName),
      deps.metadata
    );
    const description = response.data?.description;
    return typeof description === 'string' ? description : undefined;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`[description-read] SubredditAbout failed for r/${subredditName}: ${detail}`);
  }
}

/**
 * Write the subreddit description via SiteAdmin, preserving the existing
 * public_description and every other About-sourced setting.
 */
export async function writeSubredditDescription(
  deps: DescriptionWriterDeps,
  input: { readonly subredditName: string; readonly description: string }
): Promise<void> {
  let response: { readonly data?: SubredditAboutData | undefined };
  try {
    response = await deps.subreddits.SubredditAbout(
      aboutRequest(input.subredditName),
      deps.metadata
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `[description-read] SubredditAbout failed for r/${input.subredditName}: ${detail}`
    );
  }
  const data = response.data;
  if (!data) {
    throw new Error(`subreddit About response missing data for r/${input.subredditName}`);
  }
  const request = buildDescriptionOnlyRequest(data, input.description);
  try {
    await deps.subreddits.SiteAdmin(request, deps.metadata);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `[description-write] SiteAdmin failed for r/${input.subredditName}: ${detail}`
    );
  }
}
