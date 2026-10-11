if (!process.env.CSC_LINK) {
  console.error(
    "Windows installer packaging requires a code-signing certificate. Set CSC_LINK to your trusted .p12/.pfx certificate path and CSC_KEY_PASSWORD if needed."
  );
  process.exit(1);
}

console.log("Code-signing certificate reference configured; electron-builder will validate it during packaging.");