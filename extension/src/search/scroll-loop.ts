export type ScanCheckpoint = "continue" | "stop";

export type ScrollLoopPage<Post> = {
  getPosts(): Post[];
  getPostId(post: Post): string;
  expandPost(post: Post): void | Promise<void>;
  processPost(post: Post): Promise<void>;
  afterPost?(): Promise<void>;
  scroll(): void;
  afterScroll?(): Promise<void>;
  loadMore(): Promise<void>;
  waitDelay(): Promise<void>;
  checkpoint(): Promise<ScanCheckpoint>;
  onProgress(scrollCount: number, postsScanned: number): void | Promise<void>;
};

export type ScrollLoopOptions = {
  maxScrolls: number;
  maxPosts: number;
  stopAfterNoNewPosts: number;
  initialPostsScanned?: number;
  initialScrollCount?: number;
  processedPostIds?: string[];
};

export type ScrollLoopResult = {
  scrollCount: number;
  postsScanned: number;
  stopped: boolean;
};

export async function runScrollLoop<Post>(
  page: ScrollLoopPage<Post>,
  options: ScrollLoopOptions
): Promise<ScrollLoopResult> {
  const seen = new Set<string>(options.processedPostIds ?? []);
  let scrollCount = options.initialScrollCount ?? 0;
  let postsScanned = options.initialPostsScanned ?? 0;
  let emptyScrolls = 0;
  let wasStopped = false;

  const processVisible = async (): Promise<number> => {
    let discovered = 0;
    for (const post of page.getPosts()) {
      if (postsScanned >= options.maxPosts) break;
      if (await page.checkpoint() === "stop") {
        wasStopped = true;
        return discovered;
      }
      const id = page.getPostId(post);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      await page.expandPost(post);
      if (await page.checkpoint() === "stop") {
        wasStopped = true;
        return discovered;
      }
      await page.processPost(post);
      postsScanned++;
      discovered++;
      await page.onProgress(scrollCount, postsScanned);
      await page.afterPost?.();
      if (await page.checkpoint() === "stop") {
        wasStopped = true;
        return discovered;
      }
    }
    return discovered;
  };

  let newlyFound = await processVisible();
  if (wasStopped) return { scrollCount, postsScanned, stopped: true };
  if (postsScanned >= options.maxPosts) return { scrollCount, postsScanned, stopped: false };

  while (scrollCount < options.maxScrolls && emptyScrolls < options.stopAfterNoNewPosts) {
    if (await page.checkpoint() === "stop") return { scrollCount, postsScanned, stopped: true };
    await page.waitDelay();
    if (await page.checkpoint() === "stop") return { scrollCount, postsScanned, stopped: true };
    await page.loadMore();
    page.scroll();
    scrollCount++;
    await page.afterScroll?.();
    if (await page.checkpoint() === "stop") return { scrollCount, postsScanned, stopped: true };
    const previousCount = postsScanned;
    newlyFound = await processVisible();
    if (wasStopped) return { scrollCount, postsScanned, stopped: true };
    emptyScrolls = postsScanned === previousCount && newlyFound === 0 ? emptyScrolls + 1 : 0;
    await page.onProgress(scrollCount, postsScanned);
    if (postsScanned >= options.maxPosts) break;
  }
  return { scrollCount, postsScanned, stopped: false };
}
