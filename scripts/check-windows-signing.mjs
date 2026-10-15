if (!process.env.CSC_LINK) {
  console.warn(
    "Notice: CSC_LINK is not set. Packaging an unsigned Windows installer. Windows SmartScreen may show an untrusted publisher notice on installation."
  );
} else {
  console.log("Code-signing certificate reference configured; electron-builder will validate it during packaging.");
}