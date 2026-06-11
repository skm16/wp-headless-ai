// Type stubs for the esbuild-virtual modules consumed by entry.tsx.
// Real implementations are supplied at bundle time (lib/draft/bundle.ts).
declare module "virtual:dispatcher" {
  import type { ComponentType } from "react";
  export const BlockDispatcher: ComponentType<{ block: unknown }>;
}
declare module "virtual:shell-header" {
  import type { ComponentType } from "react";
  export const Header: ComponentType;
}
declare module "virtual:shell-footer" {
  import type { ComponentType } from "react";
  export const Footer: ComponentType;
}
