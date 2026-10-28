# ah-web assets

The server reads plugin-owned HTML/CSS from `web.static_dir` under the plugin root.
Server-owned assets live in this crate at `web/static/` and ship next to the
`ah-web` binary under that same relative directory. `ah-engine/scripts/package.sh`
includes them whenever it includes `ah-web`; install or copy that directory with
the server binary. The engine install routine only checks ah-web compatibility;
it does not install the dashboard.

ApexCharts stays pinned to **4.7.0** in `web/static/vendor/apexcharts.min.js`.
Its browser URL remains `/static/vendor/apexcharts.min.js`, with the same cookie,
path and MIME checks. Plugin files retain precedence; package assets supply files
absent from the plugin. No chart library ships in the plugin directory.
