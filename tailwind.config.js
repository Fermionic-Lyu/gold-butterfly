import typography from "@tailwindcss/typography";

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx,ts,tsx}"],
  theme: {
    extend: {
      colors: {
        gold: {
          50: "#fff9e0",
          100: "#fef0b8",
          200: "#fbe07a",
          300: "#f7cd42",
          400: "#eeb71b",
          500: "#d49b0c",
          600: "#a87706",
          700: "#7d5705",
          800: "#553a05",
          900: "#2e1f04",
        },
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [typography],
};
