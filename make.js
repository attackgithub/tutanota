const {Promise} = require("bluebird")
const options = require('commander')
const path = require("path")
const fs = Promise.promisifyAll(require("fs-extra"))
const env = require('./buildSrc/env.js')
const LaunchHtml = require('./buildSrc/LaunchHtml.js')
const SystemConfig = require('./buildSrc/SystemConfig.js')
const os = require("os")

const {spawn} = require("child_process")
const RollupConfig = require("./buildSrc/RollupConfig")

let flow
try {
	flow = require('flow-bin')
} catch (e) {
	// we don't have flow on F-Droid
	console.log("flow-bin not found, stubbing it")
	flow = 'true'
}
// const desktopBuilder = require("./buildSrc/DesktopBuilder")

const rollup = require("rollup")


async function createHtml(env, watch) {
	let filenamePrefix
	switch (env.mode) {
		case "App":
			filenamePrefix = "app"
			break
		case "Browser":
			filenamePrefix = "index"
			break
		case "Desktop":
			filenamePrefix = "desktop"
	}
	let imports = SystemConfig.baseDevDependencies.concat([`${filenamePrefix}Bootstrap.js`])
	const template = fs.readFileSync("./buildSrc/bootstrap.template.js", "utf8")
	await _writeFile(`./build/${filenamePrefix}Bootstrap.js`, [
		`window.whitelabelCustomizations = null`,
		`window.env = ${JSON.stringify(env, null, 2)}`,
		watch ? "new WebSocket('ws://localhost:8080').addEventListener('message', (e) => window.hotReload())" : "",
	].join("\n") + "\n" + template)
	const html = await LaunchHtml.renderHtml(imports, env)
	await _writeFile(`./build/${filenamePrefix}.html`, html)
}

function _writeFile(targetFile, content) {
	return fs.mkdirsAsync(path.dirname(targetFile)).then(() => fs.writeFileAsync(targetFile, content, 'utf-8'))
}

async function prepareAssets(watch) {
	let restUrl
	await Promise.all([
		await fs.emptyDirAsync("build/images"),
		fs.copyAsync(path.join(__dirname, '/resources/favicon'), path.join(__dirname, '/build/images')),
		fs.copyAsync(path.join(__dirname, '/resources/images/'), path.join(__dirname, '/build/images')),
		fs.copyAsync(path.join(__dirname, '/libs'), path.join(__dirname, '/build/libs'))
	])
	if (options.stage === 'test') {
		restUrl = 'https://test.tutanota.com'
	} else if (options.stage === 'prod') {
		restUrl = 'https://mail.tutanota.com'
	} else if (options.stage === 'local') {
		restUrl = "http://" + os.hostname().split(".")[0] + ":9000"
	} else { // host
		restUrl = options.host
	}

	await fs.copyFileAsync(path.join(__dirname, "/src/api/worker/WorkerBootstrap.js"), path.join(__dirname, '/build/WorkerBootstrap.js'))

	return Promise.all([
		createHtml(env.create(SystemConfig.devConfig(true), (options.stage === 'local') ? null : restUrl, version, "Browser"), watch),
		createHtml(env.create(SystemConfig.devConfig(true), restUrl, version, "App"), watch),
		createHtml(env.create(SystemConfig.devConfig(false), restUrl, version, "Desktop"), watch)
	])
}

function startFlowCheck() {
	spawn(flow, [], {stdio: [process.stdin, process.stdout, process.stderr]})
}

function readCache(cacheLocation) {
	return fs.existsSync(cacheLocation) && JSON.parse(fs.readFileSync(cacheLocation, {encoding: "utf8"}))
}

async function build({watch, desktop}) {
	startFlowCheck()
	await prepareAssets(watch)

	const inputOptions = {
		input: ["src/app.js", "src/api/worker/WorkerImpl.js"],
		plugins: RollupConfig.rollupDebugPlugins(),
		treeshake: false, // disable tree-shaking for faster development builds
		preserveModules: true,
	}
	const outputOptions = Object.assign({}, RollupConfig.outConfig, {sourcemap: "inline", dir: "build"})

	if (watch) {
		const WebSocket = require("ws")
		const server = new WebSocket.Server({
			port: 8080
		})
		rollup.watch(Object.assign({}, inputOptions, outputOptions)).on("event", (e) => {
			switch (e.code) {
				case "START":
					console.log("Started bundling")
					break
				case "BUNDLE_START":
					console.log("Started bundle", e.input)
					break
				case "BUNDLE_END":
					console.log("Finished bundle ", e.input, " in ", e.duration)
					server.clients.forEach((c) => c.send("reload"))
					break
				case "END":
					console.log("Finished bundling")
					break
				case "ERROR":
					console.warn("Error during bundling", e)
					break
				case "FATAL":
					console.error("Fatal error duing bunling", e)
					break
			}
		})
	} else {
		const cacheLocation = "./build/main-bundle-cache"
		const cache = readCache(cacheLocation)
		cache && console.log("using cache for web bundle")
		const bundle = await rollup.rollup(Object.assign({}, inputOptions, {cache}))
		await fs.writeFileAsync(cacheLocation, JSON.stringify(bundle.cache))
		await bundle.write(outputOptions)
	}
	if (desktop) {
		await startDesktop()
	}
}

const packageJSON = require('./package.json')
const version = packageJSON.version

options
	.usage('[options] [test|prod|local|host <url>], "local" is default')
	.arguments('[stage] [host]')
	.option('-c, --clean', 'Clean build directory')
	.option('-w, --watch', 'Watch build dir and rebuild if necessary')
	.option('-d, --desktop', 'assemble & start desktop client')
	.action(function (stage, host) {
		if (!["test", "prod", "local", "host", undefined].includes(stage)
			|| (stage !== "host" && host)
			|| (stage === "host" && !host)) {
			options.outputHelp()
			process.exit(1)
		}
		options.stage = stage || "local"
		options.host = host
	})
	.parse(process.argv)

if (options.clean) {
	console.log("cleaning build dir")
	fs.emptyDirAsync("build")
}

build(options)

async function startDesktop() {
	console.log("Building desktop client...")
	const packageJSON = require('./buildSrc/electron-package-json-template.js')(
		"",
		"0.0.1",
		"http://localhost:9000",
		path.join(__dirname, "/resources/desktop-icons/logo-solo-red.png"),
		false
	)
	const content = JSON.stringify(packageJSON)

	await fs.createFileAsync("./build/package.json")
	await fs.writeFileAsync("./build/package.json", content, 'utf-8')

	const cacheLocation = "./build/desktop-bundle-cache"
	const cache = readCache(cacheLocation)
	cache && console.log("using cache for desktop bundle")
	const bundle = await rollup.rollup({
		input: ["src/desktop/DesktopMain.js", "src/desktop/preload.js"],
		plugins: [
			babel({
				plugins: [
					// Using Flow plugin and not preset to run before class-properties and avoid generating strange property code
					"@babel/plugin-transform-flow-strip-types",
					"@babel/plugin-proposal-class-properties",
					"@babel/plugin-syntax-dynamic-import"
				],
			}),
			commonjs({
				exclude: "src/**",
			}),
		],
		treeshake: false, // disable tree-shaking for faster development builds
		preserveModules: true,
		cache,
	})
	await fs.writeFileAsync(cacheLocation, JSON.stringify(bundle.cache))


	await bundle.write({
		format: "cjs",
		sourcemap: "inline",
		dir: "build/desktop"
	})
	console.log("Bundled desktop client")

	spawn("/bin/sh", ["-c", "npm start"], {
		stdio: ['ignore', 'inherit', 'inherit'],
		detached: false
	})
}
