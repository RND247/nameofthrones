{
  const settingsKey = "nameOfThrones:settings:v1";
  try {
    const settings = JSON.parse(localStorage.getItem(settingsKey));
    if (settings?.darkModeEnabled === false) {
      document.documentElement.classList.add("light-theme");
    }
  } catch {
    // The main app will apply safe defaults after it loads.
  }
}
