export type PendingBatchStore<T> = {
  save(batch: T): Promise<void>;
  remove(): Promise<void>;
};

export type BatchSaveResult<Result> =
  | { ok: true; result: Result }
  | { ok: false; error: Error; safetyCopySaved: boolean };

export async function retryTransientSave<Result>(
  save: () => Promise<Result>,
  shouldRetry: (error: unknown) => boolean,
  wait: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  maxAttempts = 3
): Promise<Result> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await save();
    } catch (error) {
      if (attempt === maxAttempts || !shouldRetry(error)) throw error;
      await wait(1000 * attempt);
    }
  }
  throw new Error("Save retry limit was reached.");
}

export async function saveBatchWithSafetyCopy<Batch, Result>(
  batch: Batch,
  store: PendingBatchStore<Batch>,
  save: (batch: Batch) => Promise<Result>,
  afterSave: (result: Result) => Promise<void>
): Promise<BatchSaveResult<Result>> {
  try {
    await store.save(batch);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error("The safety copy could not be written."),
      safetyCopySaved: false
    };
  }
  try {
    const result = await save(batch);
    await afterSave(result);
    await store.remove();
    return { ok: true, result };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error("The batch could not be saved."),
      safetyCopySaved: true
    };
  }
}
