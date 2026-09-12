export default function BetsLoading() {
  return (
    <main>
      <h2 style={{ marginTop: 0 }}>Picks</h2>
      <div className="page-loading">
        <span className="spinner" aria-hidden="true" />
        Loading picks...
      </div>
    </main>
  );
}
