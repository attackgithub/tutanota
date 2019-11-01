window.isBrowser = true

/**
 * runs this test exclusively on browsers (not nodec)
 */
window.browser = function (func) {
	return func
}

/**
 * runs this test exclusively on node (not browsers)
 */
window.node = function (func) {
	return function () {
	}
}

window.tutao = {}

Promise.config({
	longStackTraces: false,
	warnings: false
})

System
	.import("./src/api/Env.js")
	.then((module) => {
		module.bootFinished()
		System.import('./test/client/Suite.js')
	})

