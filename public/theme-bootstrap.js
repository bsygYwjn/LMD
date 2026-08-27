(() => {
  try {
    const storedTheme = localStorage.getItem("lmd-theme");
    const theme = storedTheme === "light" || storedTheme === "dark"
      ? storedTheme
      : matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    document.querySelector('meta[name="theme-color"]').content = theme === "light" ? "#f4f7fb" : "#0b0d12";
  } catch {
    document.documentElement.dataset.theme = "dark";
  }
})();
