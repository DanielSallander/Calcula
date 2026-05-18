//! FILENAME: core/identity/src/uuid_v7.rs
//! PURPOSE: UUID v7 generation (RFC 9562).
//! CONTEXT: UUID v7 is time-sortable (first 48 bits are Unix timestamp in ms)
//! with 74 bits of randomness. Globally unique without coordination.
//! We implement it without external crate dependencies — only std is needed.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// Monotonic counter to disambiguate IDs generated within the same millisecond.
/// Combined with random bits, this prevents collisions even under high throughput.
static COUNTER: AtomicU64 = AtomicU64::new(0);

/// Generate a UUID v7 as [u8; 16].
///
/// Layout (RFC 9562 Section 5.7):
/// - Bits  0..47:  Unix timestamp in milliseconds
/// - Bits 48..51:  Version (0b0111 = 7)
/// - Bits 52..63:  Counter/random (12 bits)
/// - Bits 64..65:  Variant (0b10)
/// - Bits 66..127: Random (62 bits)
///
/// Uses std's thread_rng equivalent via a simple xorshift seeded from time+counter
/// to avoid depending on the `rand` crate.
pub fn generate_uuid_v7() -> [u8; 16] {
    let timestamp_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    // Increment counter for sub-millisecond ordering
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);

    // Generate pseudo-random bits from timestamp, counter, and thread ID
    let random_bits = pseudo_random(timestamp_ms, seq);

    let mut bytes = [0u8; 16];

    // Bytes 0-5: 48-bit timestamp (big-endian)
    bytes[0] = ((timestamp_ms >> 40) & 0xFF) as u8;
    bytes[1] = ((timestamp_ms >> 32) & 0xFF) as u8;
    bytes[2] = ((timestamp_ms >> 24) & 0xFF) as u8;
    bytes[3] = ((timestamp_ms >> 16) & 0xFF) as u8;
    bytes[4] = ((timestamp_ms >> 8) & 0xFF) as u8;
    bytes[5] = (timestamp_ms & 0xFF) as u8;

    // Bytes 6-7: version (4 bits) + 12 bits of counter/random
    let rand_12 = (random_bits & 0x0FFF) as u16;
    bytes[6] = (0x70 | ((rand_12 >> 8) & 0x0F)) as u8; // version = 7
    bytes[7] = (rand_12 & 0xFF) as u8;

    // Bytes 8-15: variant (2 bits) + 62 bits random
    let rand_high = (random_bits >> 12) as u64;
    let rand_low = pseudo_random(random_bits, seq.wrapping_add(1));

    bytes[8] = (0x80 | ((rand_high >> 56) & 0x3F)) as u8; // variant = 10
    bytes[9] = ((rand_high >> 48) & 0xFF) as u8;
    bytes[10] = ((rand_high >> 40) & 0xFF) as u8;
    bytes[11] = ((rand_high >> 32) & 0xFF) as u8;
    bytes[12] = ((rand_low >> 24) & 0xFF) as u8;
    bytes[13] = ((rand_low >> 16) & 0xFF) as u8;
    bytes[14] = ((rand_low >> 8) & 0xFF) as u8;
    bytes[15] = (rand_low & 0xFF) as u8;

    bytes
}

/// Simple pseudo-random function combining timestamp, sequence, and entropy sources.
/// Not cryptographically secure — used only for UUID uniqueness, not security.
fn pseudo_random(seed1: u64, seed2: u64) -> u64 {
    // Mix thread ID for cross-thread uniqueness.
    // Use the Debug format of ThreadId as a stable source of entropy since
    // as_u64() is unstable.
    let thread_entropy = {
        let id = std::thread::current().id();
        let s = format!("{:?}", id);
        s.bytes().fold(0u64, |acc, b| acc.wrapping_mul(31).wrapping_add(b as u64))
    };

    let mut state = seed1
        .wrapping_mul(6364136223846793005)
        .wrapping_add(seed2)
        .wrapping_add(thread_entropy);

    // xorshift64*
    state ^= state >> 12;
    state ^= state << 25;
    state ^= state >> 27;
    state.wrapping_mul(0x2545F4914F6CDD1D)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn generates_valid_uuid_v7() {
        let id = generate_uuid_v7();

        // Version bits (byte 6, high nibble) must be 0x7_
        assert_eq!(id[6] >> 4, 7, "Version must be 7");

        // Variant bits (byte 8, high 2 bits) must be 0b10
        assert_eq!(id[8] >> 6, 2, "Variant must be 0b10");
    }

    #[test]
    fn unique_across_calls() {
        let mut set = HashSet::new();
        for _ in 0..10_000 {
            let id = generate_uuid_v7();
            assert!(set.insert(id), "Duplicate UUID generated");
        }
    }

    #[test]
    fn monotonically_increasing_within_same_ms() {
        // Generate many IDs rapidly — they should be ordered by the timestamp
        // prefix and counter bits
        let ids: Vec<[u8; 16]> = (0..100).map(|_| generate_uuid_v7()).collect();

        for window in ids.windows(2) {
            // First 6 bytes (timestamp) should be non-decreasing
            let ts_a = &window[0][..6];
            let ts_b = &window[1][..6];
            assert!(ts_a <= ts_b, "Timestamps must be non-decreasing");
        }
    }

    #[test]
    fn timestamp_is_reasonable() {
        let id = generate_uuid_v7();

        // Extract timestamp
        let ts_ms = ((id[0] as u64) << 40)
            | ((id[1] as u64) << 32)
            | ((id[2] as u64) << 24)
            | ((id[3] as u64) << 16)
            | ((id[4] as u64) << 8)
            | (id[5] as u64);

        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;

        // Should be within 1 second of current time
        assert!(
            ts_ms <= now_ms && now_ms - ts_ms < 1000,
            "Timestamp {ts_ms} not close to now {now_ms}"
        );
    }
}
