import { describe, expect, it } from "vitest";
import { runScrollLoop, type ScrollLoopPage } from "./scroll-loop";

function fakePage(posts: number[]) {
  let visibleCount = 1;
  let stopAtCheckpoint = Number.POSITIVE_INFINITY;
  let checkpoints = 0;
  const scanned: number[] = [];
  const page: ScrollLoopPage<number> = {
    getPosts: () => posts.slice(0, visibleCount),
    getPostId: (post) => String(post),
    expandPost: () => undefined,
    processPost: async (post) => { scanned.push(post); },
    scroll: () => { visibleCount = Math.min(posts.length, visibleCount + 1); },
    loadMore: async () => undefined,
    waitDelay: async () => undefined,
    checkpoint: async () => ++checkpoints >= stopAtCheckpoint ? "stop" : "continue",
    onProgress: () => undefined
  };
  return {
    page,
    scanned,
    stopAfterCheckpoint(count: number) { stopAtCheckpoint = count; }
  };
}

describe("scroll loop stopping rules", () => {
  it("stops after the configured number of scrolls without new posts", async () => {
    const fake = fakePage([1]);
    const result = await runScrollLoop(fake.page, { maxScrolls: 20, maxPosts: 30, stopAfterNoNewPosts: 3 });
    expect(result).toMatchObject({ scrollCount: 3, postsScanned: 1, stopped: false });
  });

  it("stops at the maximum scroll count", async () => {
    const fake = fakePage([1, 2, 3, 4]);
    const result = await runScrollLoop(fake.page, { maxScrolls: 2, maxPosts: 30, stopAfterNoNewPosts: 10 });
    expect(result.scrollCount).toBe(2);
  });

  it("stops at the maximum post count", async () => {
    const fake = fakePage([1, 2, 3, 4]);
    const result = await runScrollLoop(fake.page, { maxScrolls: 20, maxPosts: 2, stopAfterNoNewPosts: 3 });
    expect(result.postsScanned).toBe(2);
  });

  it("processes each post ID only once across repeated page entries", async () => {
    const fake = fakePage([1, 1, 2]);
    fake.page.getPosts = () => [1, 1, 2];
    const result = await runScrollLoop(fake.page, { maxScrolls: 0, maxPosts: 10, stopAfterNoNewPosts: 3 });
    expect(result.postsScanned).toBe(2);
    expect(fake.scanned).toEqual([1, 2]);
  });

  it("resumes after a simulated restart without reprocessing stored post IDs", async () => {
    const fake = fakePage([1, 2]);
    fake.page.getPosts = () => [1, 2];
    const result = await runScrollLoop(fake.page, {
      maxScrolls: 0,
      maxPosts: 10,
      stopAfterNoNewPosts: 3,
      initialPostsScanned: 1,
      processedPostIds: ["1"]
    });
    expect(result.postsScanned).toBe(2);
    expect(fake.scanned).toEqual([2]);
  });

  it("honors Stop at a checkpoint", async () => {
    const fake = fakePage([1, 2, 3, 4]);
    fake.stopAfterCheckpoint(4);
    const result = await runScrollLoop(fake.page, { maxScrolls: 20, maxPosts: 30, stopAfterNoNewPosts: 3 });
    expect(result.stopped).toBe(true);
  });

  it("does not advance while paused and continues after Resume", async () => {
    const fake = fakePage([1, 2]);
    let resume!: () => void;
    let paused = true;
    fake.page.checkpoint = async () => {
      if (paused) await new Promise<void>((resolve) => { resume = resolve; });
      return "continue";
    };
    let scrolls = 0;
    const scroll = fake.page.scroll;
    fake.page.scroll = () => { scrolls++; scroll(); };
    const scanning = runScrollLoop(fake.page, { maxScrolls: 1, maxPosts: 10, stopAfterNoNewPosts: 3 });
    await Promise.resolve();
    await Promise.resolve();
    expect(scrolls).toBe(0);
    paused = false;
    resume();
    const result = await scanning;
    expect(result.scrollCount).toBe(1);
    expect(fake.scanned).toEqual([1, 2]);
  });
});
