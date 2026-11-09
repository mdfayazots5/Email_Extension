// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SetupScreen } from "./SetupScreen";

const { healthMock } = vi.hoisted(() => ({ healthMock: vi.fn() }));
const INSTALL_MESSAGE = "One-time setup needed";

vi.mock("../api/client", () => ({
  ApiError: class ApiError extends Error {},
  HOST_NOT_INSTALLED_MESSAGE: "One-time setup needed",
  api: { health: () => healthMock() }
}));

vi.mock("../api/connection-logs", () => ({
  recordConnectionLog: vi.fn().mockResolvedValue(undefined)
}));

vi.mock("./ConnectionLogControls", () => ({
  ConnectionLogControls: () => null
}));

describe("SetupScreen", () => {
  afterEach(cleanup);
  beforeEach(() => {
    healthMock.mockReset();
  });

  it("connects by itself without asking for a token", async () => {
    healthMock.mockResolvedValue({});
    const onConnected = vi.fn();
    render(<SetupScreen onConnected={onConnected} />);

    await waitFor(() => expect(onConnected).toHaveBeenCalledOnce());
    expect(screen.queryByLabelText("Service token")).toBeNull();
  });

  it("shows the one-time install steps when the native host is missing, then retries", async () => {
    const { ApiError } = await import("../api/client");
    healthMock.mockRejectedValueOnce(new ApiError(INSTALL_MESSAGE, "offline")).mockResolvedValueOnce({});
    const onConnected = vi.fn();
    render(<SetupScreen onConnected={onConnected} />);

    expect(await screen.findByText("One-time setup")).toBeTruthy();
    expect(screen.getByText("Run the installer once")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(onConnected).toHaveBeenCalledOnce());
  });
});
