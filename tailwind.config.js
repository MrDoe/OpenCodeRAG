/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/web/ui/index.html", "./src/web/ui/src/**/*.{tsx,ts}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        brand: { 400: "#22d3ee", 500: "#06b6d4", 600: "#0891b2" },
      },
    },
  },
  plugins: [],
};
