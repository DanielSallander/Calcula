//! FILENAME: core/calp/src/cross_package.rs
//! PURPOSE: Cross-package reference tracking and registry-side dependency graph.
//! CONTEXT: A .cala may subscribe to multiple .calp packages. Formulas in one
//! package's sheets can reference cells in another package's sheets. The registry
//! tracks these dependencies (declared, not strictly enforced in v1).

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::manifest::Subscription;

/// A declared dependency between packages.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageDependency {
    /// The package that has the dependency (references cells in another package).
    pub from_package: String,
    /// The package being referenced.
    pub to_package: String,
}

/// Registry-side dependency graph across packages.
/// This is declared (populated from metadata), not inferred from formula analysis.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageDependencyGraph {
    /// All declared inter-package dependencies.
    pub dependencies: Vec<PackageDependency>,
}

impl PackageDependencyGraph {
    pub fn new() -> Self {
        Self::default()
    }

    /// Add a dependency.
    pub fn add(&mut self, from: &str, to: &str) {
        if !self.has_dependency(from, to) {
            self.dependencies.push(PackageDependency {
                from_package: from.to_string(),
                to_package: to.to_string(),
            });
        }
    }

    /// Check if a dependency exists.
    pub fn has_dependency(&self, from: &str, to: &str) -> bool {
        self.dependencies.iter()
            .any(|d| d.from_package == from && d.to_package == to)
    }

    /// Get all packages that `package` depends on.
    pub fn dependencies_of(&self, package: &str) -> Vec<&str> {
        self.dependencies.iter()
            .filter(|d| d.from_package == package)
            .map(|d| d.to_package.as_str())
            .collect()
    }

    /// Get all packages that depend on `package`.
    pub fn dependents_of(&self, package: &str) -> Vec<&str> {
        self.dependencies.iter()
            .filter(|d| d.to_package == package)
            .map(|d| d.from_package.as_str())
            .collect()
    }

    /// Compute refresh order: packages that are depended on should refresh first.
    /// Returns packages in topological order, or None if there's a cycle.
    pub fn refresh_order(&self, subscribed_packages: &[String]) -> Option<Vec<String>> {
        let pkg_set: HashSet<&str> = subscribed_packages.iter().map(|s| s.as_str()).collect();

        // Build in-degree map
        let mut in_degree: HashMap<&str, usize> = HashMap::new();
        for pkg in &pkg_set {
            in_degree.insert(pkg, 0);
        }
        for dep in &self.dependencies {
            if pkg_set.contains(dep.from_package.as_str()) && pkg_set.contains(dep.to_package.as_str()) {
                *in_degree.entry(dep.from_package.as_str()).or_insert(0) += 1;
            }
        }

        // Kahn's algorithm
        let mut queue: Vec<&str> = in_degree.iter()
            .filter(|(_, &deg)| deg == 0)
            .map(|(&pkg, _)| pkg)
            .collect();
        queue.sort(); // deterministic order

        let mut result = Vec::new();
        while let Some(pkg) = queue.pop() {
            result.push(pkg.to_string());
            for dep in &self.dependencies {
                if dep.to_package == pkg && pkg_set.contains(dep.from_package.as_str()) {
                    if let Some(deg) = in_degree.get_mut(dep.from_package.as_str()) {
                        *deg -= 1;
                        if *deg == 0 {
                            queue.push(dep.from_package.as_str());
                            queue.sort();
                        }
                    }
                }
            }
        }

        if result.len() == pkg_set.len() {
            Some(result)
        } else {
            None // cycle
        }
    }

    /// Build the dependency graph from a workbook's subscriptions.
    /// Cross-package references are identified by sheet names that belong
    /// to different packages.
    pub fn from_subscriptions(subscriptions: &[Subscription]) -> Self {
        // In v1, dependencies are declared, not inferred.
        // This returns an empty graph — callers add dependencies explicitly.
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_and_query_dependencies() {
        let mut graph = PackageDependencyGraph::new();
        graph.add("report-a", "data-source");
        graph.add("report-b", "data-source");

        assert!(graph.has_dependency("report-a", "data-source"));
        assert!(graph.has_dependency("report-b", "data-source"));
        assert!(!graph.has_dependency("data-source", "report-a"));

        assert_eq!(graph.dependencies_of("report-a"), vec!["data-source"]);
        assert_eq!(graph.dependents_of("data-source"), vec!["report-a", "report-b"]);
    }

    #[test]
    fn no_duplicate_dependencies() {
        let mut graph = PackageDependencyGraph::new();
        graph.add("a", "b");
        graph.add("a", "b"); // duplicate
        assert_eq!(graph.dependencies.len(), 1);
    }

    #[test]
    fn refresh_order_respects_dependencies() {
        let mut graph = PackageDependencyGraph::new();
        graph.add("report", "data");
        graph.add("summary", "report");

        let packages = vec!["summary".to_string(), "report".to_string(), "data".to_string()];
        let order = graph.refresh_order(&packages).unwrap();

        // data should come before report, report before summary
        let pos_data = order.iter().position(|p| p == "data").unwrap();
        let pos_report = order.iter().position(|p| p == "report").unwrap();
        let pos_summary = order.iter().position(|p| p == "summary").unwrap();
        assert!(pos_data < pos_report);
        assert!(pos_report < pos_summary);
    }

    #[test]
    fn refresh_order_detects_cycle() {
        let mut graph = PackageDependencyGraph::new();
        graph.add("a", "b");
        graph.add("b", "a");

        let packages = vec!["a".to_string(), "b".to_string()];
        assert!(graph.refresh_order(&packages).is_none());
    }

    #[test]
    fn refresh_order_independent_packages() {
        let graph = PackageDependencyGraph::new();
        let packages = vec!["alpha".to_string(), "beta".to_string()];
        let order = graph.refresh_order(&packages).unwrap();
        assert_eq!(order.len(), 2);
    }
}
