use super::Point;

/// Recognize one clean modifier tap without stealing ordinary keyboard events.
#[derive(Default)]
pub struct TriggerGesture {
    down: bool,
    used: bool,
    origin: Point,
}
impl TriggerGesture {
    pub fn key(
        &mut self,
        code: i32,
        down: bool,
        trigger: i32,
        point: Point,
        chord: bool,
    ) -> Option<Point> {
        if code != trigger {
            if down && self.down {
                self.used = true;
            }
            return None;
        }
        if down {
            if !self.down {
                self.down = true;
                self.used = chord;
                self.origin = point;
            }
            return None;
        }
        let tapped = self.down && !self.used;
        self.down = false;
        self.used = false;
        tapped.then_some(self.origin)
    }
    pub fn mouse(&mut self) {
        if self.down {
            self.used = true;
        }
    }
    pub fn reset(&mut self) {
        *self = Self::default();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const CTRL: i32 = 0xa2;
    #[test]
    fn a_short_tap_fires_once_on_release_and_keeps_the_original_pointer() {
        let mut gesture = TriggerGesture::default();
        let p = Point { x: 80, y: 90 };
        assert!(gesture.key(CTRL, true, CTRL, p, false).is_none());
        assert!(gesture.key(CTRL, true, CTRL, p, false).is_none()); // OS key repeat
        let result = gesture
            .key(CTRL, false, CTRL, Point { x: 81, y: 90 }, false)
            .unwrap();
        assert_eq!((result.x, result.y), (80, 90));
        assert!(gesture.key(CTRL, false, CTRL, p, false).is_none());
    }
    #[test]
    fn copy_paste_and_existing_chords_do_not_become_lookups() {
        let mut gesture = TriggerGesture::default();
        for letter in [0x43, 0x56] {
            gesture.key(CTRL, true, CTRL, Point::default(), false);
            gesture.key(letter, true, CTRL, Point::default(), false);
            assert!(gesture
                .key(CTRL, false, CTRL, Point::default(), false)
                .is_none());
        }
        gesture.key(CTRL, true, CTRL, Point::default(), true);
        assert!(gesture
            .key(CTRL, false, CTRL, Point::default(), false)
            .is_none());
    }
    #[test]
    fn mouse_gestures_and_setting_changes_cancel_a_pending_tap() {
        let mut gesture = TriggerGesture::default();
        gesture.key(CTRL, true, CTRL, Point::default(), false);
        gesture.mouse();
        assert!(gesture
            .key(CTRL, false, CTRL, Point::default(), false)
            .is_none());
        gesture.key(CTRL, true, CTRL, Point::default(), false);
        gesture.reset();
        assert!(gesture
            .key(CTRL, false, CTRL, Point::default(), false)
            .is_none());
    }
}
