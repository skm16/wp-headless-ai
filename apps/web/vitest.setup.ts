import { vi } from "vitest";

// `import "server-only"` is a Next.js marker package whose body throws at
// runtime outside a server bundle. In vitest we're already running on Node
// with no client-side risk, so a no-op stub is correct.
vi.mock("server-only", () => ({}));
