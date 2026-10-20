//! Who a document belongs to.
//!
//! Each user's document lives in a directory named after their subject, so a
//! subject is only usable once it is known to be safe as a single path
//! component. That is checked once, here, rather than trusted wherever a path
//! is built: Rauthy's ids happen to be alphanumeric today, but `..`, `a/b` or
//! an empty string would otherwise reach outside the user's own directory.

use std::fmt;

/// Generous for any provider's ids, and far below a filesystem's name limit.
const MAX_LEN: usize = 128;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct UserId(String);

impl UserId {
    /// `None` unless every character is `[A-Za-z0-9_-]`, which rules out
    /// separators, dot-segments and anything a filesystem treats specially.
    pub fn parse(subject: &str) -> Option<Self> {
        let usable = !subject.is_empty()
            && subject.len() <= MAX_LEN
            && subject
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
        usable.then(|| Self(subject.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for UserId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_ids_are_accepted() {
        for id in ["outlinerkimstebel0000001", "a", "with-dash_and_underscore"] {
            assert_eq!(UserId::parse(id).map(|u| u.to_string()), Some(id.to_string()));
        }
    }

    #[test]
    fn anything_that_could_leave_the_directory_is_refused() {
        for id in ["", ".", "..", "../x", "a/b", "a\\b", "/abs", "a.b", "a b", "ä", "a\0"] {
            assert_eq!(UserId::parse(id), None, "{id:?}");
        }
    }

    #[test]
    fn overlong_ids_are_refused() {
        assert!(UserId::parse(&"a".repeat(MAX_LEN)).is_some());
        assert!(UserId::parse(&"a".repeat(MAX_LEN + 1)).is_none());
    }
}
