if (typeof process.getuid !== "function" || process.getuid() === 0) {
  throw new Error("Agent command unexpectedly ran as root");
}

console.log(`SANDBOX_USER_ID=${process.getuid()}`);
console.log("DEPENDENCY_FREE_TEST_PASSED");
