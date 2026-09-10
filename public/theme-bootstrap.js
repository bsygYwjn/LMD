(() => {
  try {
    const storedTheme = localStorage.getItem("lmd-theme");
    const theme = storedTheme === "light" || storedTheme === "dark"
      ? storedTheme
      : matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    document.documentElement.style.background = theme === "light" ? "#f5f6f7" : "#101215";
    document.querySelector('meta[name="theme-color"]').content = theme === "light" ? "#f5f6f7" : "#101215";
  } catch {
    document.documentElement.dataset.theme = "dark";
  }
})();
