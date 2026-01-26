// PURPOSE: Exposes all sub-modules to the rest of the app, maintaining the same API surface.

pub mod data;
pub mod dimensions;
pub mod nav;
pub mod search;
pub mod structure;
pub mod styles;
pub mod utils;

// Re-export commands so they are accessible via crate::commands::*
pub use data::*;
pub use dimensions::*;
pub use nav::*;
pub use search::*;
pub use structure::*;
pub use styles::*;