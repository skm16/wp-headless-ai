/**
 * `jab generate` — Round A.
 *
 * Reads the manifest written by `init` and emits TypeScript types — one
 * `<PascalName>Input` and `<PascalName>Output` per ability — to
 * `<project-dir>/lib/sdk/types.ts`.
 *
 * Round B will add a portable runtime client and one typed function per
 * ability. Round C adds `sync`. This command intentionally writes types
 * only for now: tight, demonstrable, and the inputs to Round B are exactly
 * what gets emitted here.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { compile, type JSONSchema } from "json-schema-to-typescript";
import {
  MANIFEST_SCHEMA_VERSION,
  type AbilityManifestEntry,
  type Manifest,
} from "../types/manifest.js";
import { renderClientFile } from "../emit/client.js";
import { renderAbilitiesFile } from "../emit/abilities.js";
import { renderIndexFile } from "../emit/index_barrel.js";
import { renderClaudeMdFile } from "../emit/claude_md.js";

export interface GenerateOptions {
  /** Project directory containing `.jab/manifest.json`. Defaults to "." in the caller. */
  projectDir: string;
}

export async function runGenerate(opts: GenerateOptions): Promise<void> {
  const manifestPath = path.resolve(opts.projectDir, ".jab", "manifest.json");
  const manifest = await loadManifest(manifestPath);

  console.log(`→ Loaded manifest from ${manifestPath}`);
  console.log(`  source:     ${manifest.source}`);
  console.log(`  fetchedAt:  ${manifest.fetchedAt}`);
  console.log(`  abilities:  ${manifest.abilities.length}`);

  const sections: string[] = [];
  const abilityNames: AbilityNameMap[] = [];
  for (const ability of manifest.abilities) {
    process.stdout.write(`  → ${ability.name} … `);
    const block = await compileAbility(ability);
    sections.push(block);
    abilityNames.push(makeAbilityNames(ability));
    console.log("ok");
  }

  const outDir = path.resolve(opts.projectDir, "lib", "sdk");
  await mkdir(outDir, { recursive: true });

  const typesPath = path.join(outDir, "types.ts");
  await writeFile(typesPath, renderTypesFile(manifest, sections), "utf8");

  const clientPath = path.join(outDir, "client.ts");
  await writeFile(clientPath, renderClientFile(manifest), "utf8");

  const abilitiesPath = path.join(outDir, "abilities.ts");
  await writeFile(abilitiesPath, renderAbilitiesFile(manifest, abilityNames), "utf8");

  const indexPath = path.join(outDir, "index.ts");
  await writeFile(indexPath, renderIndexFile(), "utf8");

  const claudeMdPath = path.join(outDir, "CLAUDE.md");
  await writeFile(claudeMdPath, renderClaudeMdFile(manifest, abilityNames), "utf8");

  console.log(`\n✓ Wrote SDK to ${outDir}`);
  console.log(`    - types.ts      (${manifest.abilities.length * 2} type(s))`);
  console.log(`    - client.ts     (portable MCP HTTP client, zero deps)`);
  console.log(`    - abilities.ts  (${manifest.abilities.length} typed function(s))`);
  console.log(`    - index.ts      (barrel)`);
  console.log(`    - CLAUDE.md     (generated SDK reference for Claude Code)`);
}

/** Per-ability name bundle used by the abilities/index emitters. */
export interface AbilityNameMap {
  /** Original ability identifier as registered in WP (e.g. "jab/get-posts"). */
  abilityName: string;
  /** PascalCase root used for type names. */
  pascal: string;
  /** camelCase function name for the abilities.ts wrapper (e.g. "getPosts"). */
  camel: string;
  /** True when the ability's input schema accepts no properties. */
  hasNoInput: boolean;
  /** True when the input schema declares one or more required properties. */
  hasRequiredInput: boolean;
}

function makeAbilityNames(ability: AbilityManifestEntry): AbilityNameMap {
  const pascal = abilityNameToPascal(ability.name);
  return {
    abilityName: ability.name,
    pascal,
    camel: pascal[0]!.toLowerCase() + pascal.slice(1),
    hasNoInput: !hasInputProperties(ability.inputSchema),
    hasRequiredInput: hasRequiredInputProperties(ability.inputSchema),
  };
}

function hasInputProperties(schema: Record<string, unknown>): boolean {
  const props = schema.properties;
  return typeof props === "object" && props !== null && Object.keys(props as object).length > 0;
}

function hasRequiredInputProperties(schema: Record<string, unknown>): boolean {
  const required = schema.required;
  return Array.isArray(required) && required.length > 0;
}

async function loadManifest(manifestPath: string): Promise<Manifest> {
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(
        `Manifest not found at ${manifestPath}. Run \`jab init <wp-url>\` first.`,
      );
    }
    throw err;
  }

  let manifest: Manifest;
  try {
    manifest = JSON.parse(raw) as Manifest;
  } catch (err) {
    throw new Error(
      `Manifest at ${manifestPath} is not valid JSON: ${(err as Error).message}`,
    );
  }

  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new Error(
      `Manifest schemaVersion ${manifest.schemaVersion} is not supported by this CLI (expected ${MANIFEST_SCHEMA_VERSION}). Re-run \`init\` to refresh.`,
    );
  }
  if (!Array.isArray(manifest.abilities) || manifest.abilities.length === 0) {
    throw new Error(`Manifest at ${manifestPath} contains no abilities.`);
  }
  return manifest;
}

async function compileAbility(ability: AbilityManifestEntry): Promise<string> {
  const pascal = abilityNameToPascal(ability.name);
  const inputName = `${pascal}Input`;
  const outputName = `${pascal}Output`;

  const blocks: string[] = [
    `// ${ability.name} — ${ability.label}`,
  ];

  blocks.push(
    await compileSchema(ability.inputSchema, inputName, ability.description),
  );

  if (ability.outputSchema) {
    blocks.push(await compileSchema(ability.outputSchema, outputName));
  }

  return blocks.join("\n");
}

async function compileSchema(
  schema: Record<string, unknown>,
  name: string,
  description?: string,
): Promise<string> {
  // Per-call bannerComment is suppressed; we add a single file-level header instead.
  const compiled = await compile(schema as JSONSchema, name, {
    bannerComment: "",
    additionalProperties: false,
    style: { semi: true, singleQuote: false },
  });
  if (description) {
    return `/** ${description} */\n${compiled.trim()}\n`;
  }
  return `${compiled.trim()}\n`;
}

function renderTypesFile(manifest: Manifest, sections: string[]): string {
  const header = [
    "/**",
    " * AUTOGENERATED. Do not edit by hand.",
    " *",
    " * Source:      " + manifest.source,
    " * Fetched at:  " + manifest.fetchedAt,
    " * Manifest v:  " + manifest.schemaVersion,
    " * Abilities:   " + manifest.abilities.length,
    " *",
    " * Regenerate with: `jab generate <project-dir>`",
    " */",
    "",
    "/* eslint-disable */",
    "/* tslint:disable */",
    "",
  ].join("\n");
  return header + sections.join("\n") + "\n";
}

/**
 * Convert an ability name to a PascalCase identifier.
 *
 *   jab/get-posts -> GetPosts
 *   jab/get-menus -> GetMenus
 */
export function abilityNameToPascal(name: string): string {
  const tail = name.includes("/") ? name.split("/").slice(1).join("-") : name;
  const words = tail.split(/[-_/\s]+/).filter(Boolean);
  if (words.length === 0) {
    throw new Error(`Cannot derive PascalCase name from ability "${name}"`);
  }
  return words
    .map((w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase())
    .join("");
}
