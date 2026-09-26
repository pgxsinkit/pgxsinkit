/**
 * The words of a command line initdb hands to `system()` / `popen()`, up to the first shell operator.
 *
 * initdb runs its backend through a shell command (`"/pglite/bin/postgres" --boot -X 1048576 …`, or
 * `… template1 >"/dev/null"`); the host runs that backend itself, so it needs the argument words, not a
 * shell. Quoting is honoured (`'…'`, `"…"` with `\` escaping `"`, `\`, `$` and backtick, and a bare
 * `\`); the first redirection or control operator (`< > | & ; ( )`) ends the words, as a shell would
 * end the command there.
 */
export function commandWords(command: string): string[] {
  const words: string[] = [];
  let current = "";
  let inWord = false;
  let index = 0;
  const end = command.length;
  const finishWord = () => {
    if (inWord) words.push(current);
    current = "";
    inWord = false;
  };

  while (index < end) {
    const char = command[index] ?? "";
    if (char === "'") {
      const close = command.indexOf("'", index + 1);
      if (close === -1) throw new SyntaxError(`unterminated ' in command line: ${command}`);
      current += command.slice(index + 1, close);
      inWord = true;
      index = close + 1;
    } else if (char === '"') {
      inWord = true;
      index++;
      while (index < end && command[index] !== '"') {
        const inner = command[index] ?? "";
        const next = command[index + 1];
        if (inner === "\\" && next !== undefined && '"\\$`'.includes(next)) {
          current += next;
          index += 2;
        } else {
          current += inner;
          index++;
        }
      }
      if (index >= end) throw new SyntaxError(`unterminated " in command line: ${command}`);
      index++;
    } else if (char === "\\") {
      const next = command[index + 1];
      if (next !== undefined) current += next;
      inWord = true;
      index += 2;
    } else if (/\s/.test(char)) {
      finishWord();
      index++;
    } else if ("<>|&;()".includes(char)) {
      break;
    } else {
      current += char;
      inWord = true;
      index++;
    }
  }
  finishWord();
  return words;
}
