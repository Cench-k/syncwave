import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        bg: "#0b0d10",
        panel: "#15181d",
        border: "#262a31",
        accent: "#5eead4",
        accentDim: "#0d9488",
        muted: "#8b95a3",
      },
    },
  },
  plugins: [],
};
export default config;
