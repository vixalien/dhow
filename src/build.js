const {
	join,
	resolve,
	posix: { join: posixJoin, normalize: posixNormalize },
	dirname,
} = require('path')
const fg = require('fast-glob')
const {
	copy,
	readFile,
	ensureFile,
	writeFile,
	remove,
	exists,
} = require('fs-extra')
const { startService } = require('esbuild')
const document = require('min-document')
const postcss = require('postcss')

async function build(indir, outdir) {
	global.headContents = []
	require('dotenv').config()

	const basedir = resolve(outdir)

	// Clear the require cache
	for (const file of Object.keys(require.cache)) {
		if (file.startsWith(basedir)) {
			delete require.cache[file]
		}
	}

	document.body.childNodes = []
	document.body.innerHTML = ''
	document.head.childNodes = []
	document.head.innerHTML = ''

	// Start the esbuild child process once
	const service = await startService()
	const jsFiles = await fg(posixJoin(indir, '/**/*.js'))

	const services = jsFiles.map(async (file) =>
		service.build({
			entryPoints: [file],
			outfile: join(basedir, file),
			bundle: true,
			platform: 'node',
			format: 'cjs',
			loader: {
				'.js': 'jsx',
			},
			jsxFactory: 'Explosiv.el',
			jsxFragment: 'Explosiv.fragment',
		})
	)

	try {
		if (await exists(resolve('public'))) await copy(resolve('public'), basedir)

		const cssFiles = await fg(posixJoin(outdir, '/**/*.css'))

		let postcssPlugins = null

		if (await exists(resolve('postcss.config.js'))) {
			const postcssConfig = require(resolve('postcss.config.js'))
			postcssPlugins = postcssConfig.plugins
		}

		if (postcssPlugins && postcssPlugins !== null) {
			const cssProcessor = postcss(postcssPlugins)

			for (let file of cssFiles) {
				const filePath = resolve(file)
				const result = await cssProcessor.process(await readFile(filePath), {
					from: filePath,
				})
				await writeFile(filePath, result.css)
			}
		}

		await Promise.all(services)

		let pages = await fg(posixJoin(outdir, indir, '/**/*.js'))

		if (pages.includes(posixJoin(outdir, indir, '/_document.js'))) {
			const customDocument = require(join(
				basedir,
				indir,
				'_document.js'
			)).default()

			const bodyEl = customDocument.getElementsByTagName('body')[0]
			const headEl = customDocument.getElementsByTagName('head')[0]

			Object.entries(customDocument._attributes[null]).forEach(
				([key, value]) => {
					document
						.getElementsByTagName('html')[0]
						.setAttribute(key, value.value.toString())
				}
			)

			// Have to use Array.from for `min-document` specific reasons
			Array.from(bodyEl.childNodes).forEach((childNode) => {
				document.body.appendChild(childNode)
			})

			Array.from(headEl.childNodes).forEach((childNode) => {
				document.head.appendChild(childNode)
			})

			pages = pages.filter(
				(page) => page !== posixJoin(outdir, indir, '_document.js')
			)
		} else {
			const containerDiv = document.createElement('div')
			containerDiv.className += 'root'
			document.body.appendChild(containerDiv)
		}

		for (let page of pages) {
			const fileExports = require(resolve(page))

			const filePath = posixNormalize(page)
				.split('/')
				.slice(1 + posixNormalize(indir).split('/').length)
				.join('/')
				.slice(0, -3)

			if (typeof fileExports.default === 'function') {
				if (typeof fileExports.getPaths === 'function') {
					const paths = await fileExports.getPaths()

					for (let path of paths) {
						const props = fileExports.getProps
							? await fileExports.getProps(path)
							: {}

						await writePageDOM(
							fileExports.default(props),
							join(basedir, dirname(filePath), path, 'index.html')
						)
					}
				} else {
					const props = fileExports.getProps ? await fileExports.getProps() : {}

					await writePageDOM(
						fileExports.default(props),
						join(
							basedir,
							filePath.endsWith('index') ? '' : filePath,
							'index.html'
						)
					)
				}
			} else throw `Default export from a file in ${indir} must be a funtion`
		}
	} finally {
		await remove(join(basedir, indir))

		// The child process can be explicitly killed when it's no longer needed
		service.stop()
	}
}

async function writePageDOM(pageDOM, path) {
	const rootEl = document.getElementsByClassName('root')[0]

	rootEl.appendChild(pageDOM)

	for (let node of global.headContents) {
		document.head.appendChild(node)
	}

	await ensureFile(path)
	await writeFile(path, `<!DOCTYPE html>` + document.documentElement.toString())

	rootEl.removeChild(pageDOM)

	for (let node of global.headContents) {
		document.head.removeChild(node)
	}
}

module.exports = build
