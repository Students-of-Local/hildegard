---
name: hildegard-voice
description: Design a brand-new voice from a description in words with Hildegard, listen to the candidates, and keep the one the person picks. Use when someone asks for a new voice, a character voice or a narrator voice that doesn't exist yet. Never for copying a real person's voice.
---

# Design a voice with Hildegard

The person's request is the text after `</skill>` at the end of this message.

A designed voice is invented from words. It is never a copy of a real person. If the person
wants their own voice or someone else's, stop and tell them to use Voice › Clone in the
Hildegard Studio, where the speaker gives consent live. You can never clone a voice.

1. Write a description: age, timbre, accent, pace, mood. For example
   "a weathered baritone in his sixties, slow and kind, Irish accent".
2. Run one command with the bash tool, in the foreground:

       hildegard make voice "<description>" --text "<a line for the candidates to read>"

   It waits and saves up to three candidates, each with `Audio: <path>`.
3. Tell the person the candidate paths and ask which one to keep. The output shows the keep
   command with the job id.
4. When they pick one, run:

       hildegard make voice keep <job id> <candidate number> --name "<name>"

   It prints the new voice id. Use it with `hildegard make speech "<script>" --voice <id>`.

If bash says `hildegard: command not found`, tell the person to install Hildegard from
https://dbaney.com/hildegard/ and stop. Never install it yourself.
