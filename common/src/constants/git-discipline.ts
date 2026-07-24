export const gitCommitGuidePrompt = `
### Using git to commit changes

When the user requests a new git commit, please follow these steps closely:

1. **Run two run_terminal_command tool calls:**
   - Run \`git diff\` to review both staged and unstaged modifications.
   - Run \`git log\` to check recent commit messages, ensuring consistency with this repository's style.

2. **Select relevant files to include in the commit:**
   Use the git context established at the start of this conversation to decide which files are pertinent to the changes. Stage any new untracked files that are relevant, but avoid committing previously modified files (from the beginning of the conversation) unless they directly relate to this commit.

3. **Analyze the staged changes and compose a commit message:**
   Enclose your analysis in <commit_analysis> tags. Within these tags, you should:
   - Note which files have been altered or added.
   - Categorize the nature of the changes (e.g., new feature, fix, refactor, documentation, etc.).
   - Consider the purpose or motivation behind the alterations.
   - Refrain from using tools to inspect code beyond what is presented in the git context.
   - Evaluate the overall impact on the project.
   - Check for sensitive details that should not be committed.
   - Draft a concise, one- to two-sentence commit message focusing on the “why” rather than the “what.”
   - Use precise, straightforward language that accurately represents the changes.
   - Ensure the message provides clarity—avoid generic or vague terms like “Update” or “Fix” without context.
   - Revisit your draft to confirm it truly reflects the changes and their intention.

4. **Create the commit.**
   Use a portable form that works everywhere and stays within agent terminal policy:

   **One-line message:** a single \`-m\` flag:
   \`\`\`
   git commit -m "Subject line under 72 chars"
   \`\`\`

   **Subject + body:** multiple \`-m\` flags (each \`-m\` becomes a paragraph):
   \`\`\`
   git commit -m "Subject line under 72 chars" -m "Body explaining why. No shell substitution, heredoc, or raw newlines."
   \`\`\`

   Under agent profiles, never use HEREDOC (\`<<'EOF'\`), command substitution (\`$(...)\` or backticks), pipes, redirects, or multi-line shell strings for commit messages—those forms are blocked. Keep the whole \`git commit\` command on one line. Do not amend unless the user explicitly authorized amend. Do not append any AI-attribution footer to commit messages (no "Generated with Openbuff", no "Co-Authored-By", no trailing emoji line).

**Important details**

- Prefer staging explicit paths, then committing. Avoid \`git commit -am\` when it would stage unrelated files.
- Never alter the git config.
- Do not push to the remote repository unless the user asked you to push.
- Avoid using interactive flags (e.g., \`-i\`) that require unsupported interactive input.
- Do not create an empty commit if there are no changes.
- Make sure your commit message is concise yet descriptive, focusing on the intention behind the changes rather than merely describing them. Do not append any AI-attribution footer.
`
