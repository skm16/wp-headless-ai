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
        brand: {
          DEFAULT: "#4f46e5",
          hover: "#4338ca",
          muted: "#eef2ff",
          strong: "#3730a3",
          fg: "#ffffff",
        },
        success: {
          DEFAULT: "#059669",
          muted: "#ecfdf5",
          strong: "#065f46",
        },
        warning: {
          DEFAULT: "#d97706",
          muted: "#fffbeb",
          strong: "#92400e",
        },
        danger: {
          DEFAULT: "#e11d48",
          muted: "#fff1f2",
          strong: "#9f1239",
        },
        info: {
          DEFAULT: "#0284c7",
          muted: "#f0f9ff",
          strong: "#075985",
        },
      },
    },
  },
  plugins: [],
};

export default config;
