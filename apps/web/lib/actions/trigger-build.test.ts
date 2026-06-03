import { describe, it, expect } from "vitest";
import {
  validateProjectReadyForBuild,
  TriggerBuildError,
} from "@/lib/jab/trigger-build-validation";

function readyRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "p1",
    tenant_id: "t1",
    status: "ready",
    wp_url: "https://wp.example",
    wp_username: "admin",
    wp_app_password_encrypted: Buffer.from("encrypted"),
    manifest: { abilities: [] },
    ...overrides,
  } as Parameters<typeof validateProjectReadyForBuild>[0];
}

describe("validateProjectReadyForBuild", () => {
  it("passes for a fully-configured ready project", () => {
    expect(() => validateProjectReadyForBuild(readyRow())).not.toThrow();
  });

  it("rejects when status !== ready", () => {
    expect(() =>
      validateProjectReadyForBuild(readyRow({ status: "onboarding" })),
    ).toThrow(TriggerBuildError);
    try {
      validateProjectReadyForBuild(readyRow({ status: "draft" }));
    } catch (err) {
      expect((err as TriggerBuildError).code).toBe("not_ready");
      expect((err as Error).message).toMatch(/onboarding|draft/);
    }
  });

  it("rejects when wp_url is missing", () => {
    expect(() =>
      validateProjectReadyForBuild(readyRow({ wp_url: null })),
    ).toThrow(/WordPress URL/);
  });

  it("rejects when wp_username is missing", () => {
    expect(() =>
      validateProjectReadyForBuild(readyRow({ wp_username: null })),
    ).toThrow(/credentials/);
  });

  it("rejects when the encrypted app password is missing", () => {
    expect(() =>
      validateProjectReadyForBuild(
        readyRow({ wp_app_password_encrypted: null }),
      ),
    ).toThrow(/credentials/);
  });

  it("rejects when manifest is null", () => {
    expect(() =>
      validateProjectReadyForBuild(readyRow({ manifest: null })),
    ).toThrow(/manifest/);
  });

  it("rejects when manifest is missing (undefined)", () => {
    expect(() =>
      validateProjectReadyForBuild(readyRow({ manifest: undefined })),
    ).toThrow(/manifest/);
  });

  it("uses code='not_ready' for every missing-prereq case", () => {
    const cases = [
      { wp_url: null },
      { wp_username: null },
      { wp_app_password_encrypted: null },
      { manifest: null },
      { status: "draft" },
    ];
    for (const c of cases) {
      try {
        validateProjectReadyForBuild(readyRow(c));
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(TriggerBuildError);
        expect((err as TriggerBuildError).code).toBe("not_ready");
      }
    }
  });
});
