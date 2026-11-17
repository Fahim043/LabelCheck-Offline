# Publishing LabelCheck to a public GitHub repository

This document is for the **repository owner**, not ordinary validators.

## Create the repository

1. Sign in to your GitHub account at https://github.com.
2. Visit https://github.com/new.
3. Enter repository name **LabelCheck-Offline** (or the name you prefer).
4. Description: **Offline YOLO annotation validator for Windows and macOS — correct bounding boxes, polygons, and save original TXT labels.**
5. Choose **Public**.
6. If you will upload using GitHub's website, you can leave README initialization unchecked; if a connected assistant will push the files, initialize it with a README so a `main` branch exists.
7. Click **Create repository**.

## Upload using GitHub's website (no Git installation)

1. Open the new repository.
2. Choose **Add file → Upload files** (for an empty repository, click **uploading an existing file**).
3. Drag in the **contents** of the extracted LabelCheck release folder, not the ZIP file itself. Keep `index.html`, `app.js`, `styles.css`, and `model.js` at the repository root.
4. If your browser won't upload folder structures easily, use GitHub Desktop or the Terminal method below instead.
5. Write the commit message **Initial public LabelCheck release** and choose **Commit changes**.
6. Open the repo in an incognito window to verify that the public README, demo link, and source files display.

GitHub's browser interface limits each uploaded file to 25 MiB. The demo MP4 in this release was compressed for easy upload. GitHub also accepts a screenshot and demo link in the README.

## Upload using Terminal (Mac or Windows Git)

First, install Git if it's not already installed. Once your local folder contains all the release files:

```bash
cd /path/to/LabelCheck_Offline
git init -b main
git add .
git commit -m "Initial public LabelCheck release"
git remote add origin https://github.com/YOUR_USERNAME/LabelCheck-Offline.git
git push -u origin main
```

Replace `YOUR_USERNAME` and the repository name with your GitHub values. GitHub will prompt for authentication if needed. Avoid putting passwords, API tokens, personal data, or private datasets in the repository.

## Public sharing

Share the repository URL with validators; they click **Code → Download ZIP**. If needed, create a versioned GitHub Release and attach the distributable ZIP for easier downloads. **Do not make your real dataset folders public just because the app is public.**
