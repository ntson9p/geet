/**
 * CommitMessageBox (P11-T2): the only surface `commitFlow` and `messageHistory`
 * ever needed from the SCM input box — read the message, replace the message.
 *
 * Widening the dependency to this interface is what lets the commit tool window
 * supply the message from its own editor while `gittree.commit` stays one code
 * path. `vscode.SourceControlInputBox` satisfies it structurally, so the native
 * paradigm keeps working untouched.
 */
export interface CommitMessageBox {
  value: string;
}
