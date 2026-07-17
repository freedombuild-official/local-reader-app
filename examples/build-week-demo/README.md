# Build Week Demo Workspace

This fictional workspace is packaged with Local Reader App so judges can test the reader without granting access to a personal folder.

## Start Here

- Read [Architecture](docs/architecture.md) for the sample system shape.
- Read [Safety Boundaries](docs/safety-boundaries.md) for its local-first rules.
- Inspect [`src/reader.ts`](src/reader.ts) as a source-code example.
- Open [`config/viewer.yaml`](config/viewer.yaml) as structured text.
- Review [CHANGELOG](CHANGELOG.md) for a short project history.

## Demo Checklist

- [ ] Switch this file between Rendered and Source.
- [ ] Open another file in a Fixed tab.
- [ ] Pin one reference file.
- [ ] Use Outline to jump between headings.
- [ ] Inspect file metadata in the right panel.

## Example

```ts
const workspace = createReaderWorkspace({
  mode: "local",
  writes: "disabled",
});
```

The sample contains no credentials, customer data, private paths, or network configuration.
