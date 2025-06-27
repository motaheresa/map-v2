  import MyGeoJsonMap from './MyGeoJsonMap';
import TeraaMap from './TeraaMap'; // ده اسم الملف اللي فيه الكود اللي عملناه

  // import TeraaMap fro./TeraaMapder";

  function App() {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <h1>Egypt Waterways Map</h1>
      <MyGeoJsonMap />
    </div>
    );
  }

  export default App;