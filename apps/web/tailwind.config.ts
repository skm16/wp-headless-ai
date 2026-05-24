import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // JAB dark palette. All surface/accent tokens use the
        // `rgb(var(--x) / <alpha-value>)` pattern so opacity modifiers
        // (`bg-teal/10`, `border-bord/50`) work everywhere.
        bg: "rgb(var(--bg) / <alpha-value>)",
        surf: "rgb(var(--surf) / <alpha-value>)",
        elev: "rgb(var(--elev) / <alpha-value>)",
        bord: "rgb(var(--bord) / <alpha-value>)",

        teal: "rgb(var(--teal) / <alpha-value>)",
        blue: "rgb(var(--blue) / <alpha-value>)",
        red: "rgb(var(--red) / <alpha-value>)",
        amb: "rgb(var(--amb) / <alpha-value>)",

        wht: "rgb(var(--wht) / <alpha-value>)",
        gry: "rgb(var(--gry) / <alpha-value>)",
        "gry-d": "rgb(var(--gry-d) / <alpha-value>)",

        // Legacy semantic tokens — kept so primitives in components/ui
        // continue to compile until the commit-3 sweep. They resolve to
        // the equivalent dark-palette colors.
        brand: {
          DEFAULT: "rgb(var(--teal) / <alpha-value>)",
          hover: "rgb(var(--teal) / <alpha-value>)",
          muted: "rgb(var(--teal) / 0.1)",
          strong: "rgb(var(--teal) / <alpha-value>)",
          fg: "rgb(var(--bg) / <alpha-value>)",
        },
        success: {
          DEFAULT: "rgb(var(--teal) / <alpha-value>)",
          muted: "rgb(var(--teal) / 0.1)",
          strong: "rgb(var(--teal) / <alpha-value>)",
        },
        warning: {
          DEFAULT: "rgb(var(--amb) / <alpha-value>)",
          muted: "rgb(var(--amb) / 0.1)",
          strong: "rgb(var(--amb) / <alpha-value>)",
        },
        danger: {
          DEFAULT: "rgb(var(--red) / <alpha-value>)",
          muted: "rgb(var(--red) / 0.1)",
          strong: "rgb(var(--red) / <alpha-value>)",
        },
        info: {
          DEFAULT: "rgb(var(--blue) / <alpha-value>)",
          muted: "rgb(var(--blue) / 0.1)",
          strong: "rgb(var(--blue) / <alpha-value>)",
        },
      },
      fontFamily: {
        display: ["var(--font-display)", "sans-serif"],
        body: ["var(--font-body)", "sans-serif"],
        mono: ["var(--font-mono)", "monospace"],
      },
      borderRadius: {
        // Override defaults so `rounded-lg` matches the design's 12px
        // card radius and `rounded-md` matches the 8px button/input
        // radius. Avoids sprinkling `rounded-xl` across the codebase.
        md: "0.5rem",
        lg: "0.75rem",
      },
    },
  },
  plugins: [],
};

export default config;
