/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      fontSize: {
        "2xs": ["0.6875rem", { lineHeight: "1rem" }],
      },
      colors: {
        // Muted navy primary; neutrals are Tailwind's slate scale.
        brand: {
          50: "#f1f5fa", 100: "#e1e9f3", 200: "#c4d3e6", 300: "#9bb3d2", 400: "#6b8cb8",
          500: "#4a6d9c", 600: "#37567f", 700: "#2c4567", 800: "#243953", 900: "#1c2c40",
        },
        surface: { DEFAULT: "#ffffff", muted: "#f7f8fa", sunken: "#f1f3f6" },
        line: { DEFAULT: "#e2e5ea", strong: "#cdd2da" },
      },
      borderRadius: { DEFAULT: "4px", md: "5px", lg: "6px" },
      boxShadow: {
        pop: "0 4px 16px -4px rgba(15, 23, 42, 0.18), 0 1px 3px rgba(15, 23, 42, 0.08)",
        card: "0 1px 2px rgba(15, 23, 42, 0.04)",
      },
    },
  },
  plugins: [],
};
