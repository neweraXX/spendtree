// near-sandbox@0.1.5 refuses Linux arm64 even though NEAR publishes a Linux-aarch64
// sandbox build. We point it at that binary (NEAR_SANDBOX_BINARY_PATH) and hide the
// arch check. Only used when running inside an arm64 Linux container (Apple Silicon).
const os = require('os');
if (os.type() === 'Linux' && os.arch() === 'arm64') os.arch = () => 'x64';
