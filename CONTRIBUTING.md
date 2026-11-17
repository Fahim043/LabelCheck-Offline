# Contributing to LabelCheck

Thank you for improving this free offline annotation validator!

## Reporting a bug

Open a GitHub Issue and include:

1. Mac/Windows version and Chrome/Edge version.
2. Steps to reproduce, expected behavior, and what happened instead.
3. The annotation type: YOLO box, polygon, or point.
4. A small **synthetic** sample image/label if possible. **Never upload confidential or real research datasets without permission.**

## Code contributions

The UI is plain HTML/CSS/JavaScript; no build dependencies. The YOLO parsing logic is in `model.js`, and browser interactions in `app.js`.

1. Fork the repository and create a branch.
2. Make a focused change.
3. Run the parser tests using `node test_model.js` if Node.js is installed.
4. Test selecting a local dataset, correcting a label, saving, reopening, and verifying the `.txt`.
5. Open a pull request describing what changed and how you tested it.

Please preserve offline operation and ensure unmodified YOLO label rows remain intact.
