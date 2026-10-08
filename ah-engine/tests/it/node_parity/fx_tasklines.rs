//! Transcript line builders shared by the task parity corpora (task-guard, tasklist-guard). Lines are what Claude Code writes: an
//! assistant record holding tool_use blocks (one message id per assistant message), and a user record holding the matching
//! tool_result blocks. The counter that numbers tool uses and messages runs across a whole corpus, in the order the corpus is built.

use super::jsjson::J;
use std::cell::Cell;

pub(crate) struct Tl {
    seq: Cell<usize>,
}

fn base36(mut n: usize) -> String {
    let mut digits = Vec::new();
    if n == 0 {
        digits.push(b'0');
    }
    while n > 0 {
        let d = (n % 36) as u8;
        digits.push(if d < 10 { b'0' + d } else { b'a' + d - 10 });
        n /= 36;
    }
    digits.reverse();
    String::from_utf8(digits).expect("ascii digits")
}

impl Tl {
    pub(crate) fn new() -> Tl {
        Tl { seq: Cell::new(0) }
    }
    fn bump(&self) -> usize {
        self.seq.set(self.seq.get() + 1);
        self.seq.get()
    }
    pub(crate) fn uid(&self) -> String {
        format!("toolu_{:0>6}", base36(self.bump()))
    }
    pub(crate) fn mid(&self) -> String {
        format!("msg_{:0>6}", base36(self.bump()))
    }
    /// `new Date(Date.UTC(2026, 9, 6, 8, 0, 0) + i * 1000).toISOString()`
    pub(crate) fn ts(&self, i: usize) -> String {
        super::support::iso_from_ms(1_791_273_600_000 + (i as i64) * 1000)
    }
    pub(crate) fn asst(&self, blocks: Vec<J>) -> String {
        let t = self.ts(self.seq.get());
        let id = self.mid();
        jo! {"type": "assistant", "timestamp": t, "message": jo! {"id": id, "role": "assistant", "content": blocks}}.text()
    }
    pub(crate) fn user(&self, blocks: J) -> String {
        let t = self.ts(self.seq.get());
        jo! {"type": "user", "timestamp": t, "message": jo! {"role": "user", "content": blocks}}.text()
    }
    pub(crate) fn text(&self, t: &str) -> J {
        jo! {"type": "text", "text": t}
    }
    /// A tool_use block; the id is the counter's next one unless given.
    pub(crate) fn use_(&self, name: &str, input: J) -> J {
        let id = self.uid();
        jo! {"type": "tool_use", "id": id, "name": name, "input": input}
    }
    pub(crate) fn res(&self, id: &str, content: impl Into<J>) -> J {
        jo! {"type": "tool_result", "tool_use_id": id, "content": content.into()}
    }
    /// A TaskCreate and its result as two lines.
    pub(crate) fn create(&self, n: i64, input: J) -> Vec<String> {
        let subject = match input.get("subject") {
            Some(J::Str(s)) => s.clone(),
            _ => String::new(),
        };
        let tu = self.use_("TaskCreate", input);
        let id = id_of(&tu);
        vec![self.asst(vec![tu]), self.user(ja![self.res(&id, format!("Task #{n} created successfully: {subject}"))])]
    }
    /// The input of a TaskUpdate: `{taskId: String(task_id), ...extra}`.
    pub(crate) fn update(&self, task_id: i64, extra: Vec<(&str, J)>) -> Vec<String> {
        let mut input = jo! {"taskId": task_id.to_string()};
        for (k, v) in extra {
            input.set(k, v);
        }
        let tu = self.use_("TaskUpdate", input);
        let id = id_of(&tu);
        vec![self.asst(vec![tu]), self.user(ja![self.res(&id, format!("Updated task #{task_id}"))])]
    }
    pub(crate) fn list(&self, empty: bool) -> Vec<String> {
        let tu = self.use_("TaskList", jo! {});
        let id = id_of(&tu);
        vec![self.asst(vec![tu]), self.user(ja![self.res(&id, if empty { "No tasks found" } else { "#1 [pending] x" })])]
    }
    pub(crate) fn get(&self, task_id: i64, found: bool) -> Vec<String> {
        let tu = self.use_("TaskGet", jo! {"taskId": task_id.to_string()});
        let id = id_of(&tu);
        vec![self.asst(vec![tu]), self.user(ja![self.res(&id, if found { format!("Task #{task_id}: x") } else { format!("Task #{task_id} not found") })])]
    }
    pub(crate) fn todo(&self, todos: J) -> Vec<String> {
        let tu = self.use_("TodoWrite", jo! {"todos": todos});
        vec![self.asst(vec![tu])]
    }
    pub(crate) fn bash(&self, command: &str) -> Vec<String> {
        let tu = self.use_("Bash", jo! {"command": command});
        let id = id_of(&tu);
        vec![self.asst(vec![tu]), self.user(ja![self.res(&id, "ok")])]
    }
    pub(crate) fn prompt(&self, t: &str) -> String {
        self.user(J::from(t))
    }
}

pub(crate) fn id_of(tu: &J) -> String {
    match tu.get("id") {
        Some(J::Str(s)) => s.clone(),
        _ => String::new(),
    }
}

pub(crate) fn cat(parts: Vec<Vec<String>>) -> Vec<String> {
    parts.into_iter().flatten().collect()
}
