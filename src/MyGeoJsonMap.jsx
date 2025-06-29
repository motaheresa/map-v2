import { useRef, useState, useEffect } from 'react';
import { GoogleMap, useJsApiLoader } from '@react-google-maps/api';

const containerStyle = {
  width: '100%',
  height: '100vh',
};

const center = {
  lat: 26.6235,
  lng: 31.6235,
};

function MyMap() {
  const { isLoaded } = useJsApiLoader({
    googleMapsApiKey: 'AIzaSyC5MHgv-Vax9PJqB2kROWaiVYD5AtFHnIc',
    libraries: ['geometry'],
  });

  const mapRef = useRef(null);
  const infoWindowRef = useRef(null);
  const [currentCoords, setCurrentCoords] = useState({ lat: 0, lng: 0 });
  const [lineName, setLineName] = useState(null);
  const [features, setFeatures] = useState([]);
  const [safeAreaBottom, setSafeAreaBottom] = useState('20px');

  useEffect(() => {
    const calculateSafeArea = () => {
      const isMobile = window.innerWidth <= 768;
      setSafeAreaBottom(isMobile ? '60px' : '20px');
    };

    calculateSafeArea();
    window.addEventListener('resize', calculateSafeArea);
    return () => window.removeEventListener('resize', calculateSafeArea);
  }, []);

  const handleMapLoad = (map) => {
    mapRef.current = map;
    const google = window.google;
    infoWindowRef.current = new google.maps.InfoWindow();

    // إعدادات التحكم باللمس
    map.setOptions({
      gestureHandling: 'greedy',
      gestureHandlingOptions: {
        scrollable: true,
        zoomOnDblClick: false
      },
      disableDoubleClickZoom: true,
      keyboardShortcuts: false,
      pinchZoom: false,
      fullscreenControl: false,
      streetViewControl: false
    });

    fetch('/data.json')
      .then((res) => res.json())
      .then((data) => {
        map.data.addGeoJson(data);

        map.data.setStyle({
          strokeColor: 'blue',
          strokeWeight: 4,
          strokeOpacity: 1,
        });

        const loadedFeatures = [];
        map.data.forEach((feature) => loadedFeatures.push(feature));
        setFeatures(loadedFeatures);
      });
  };

  useEffect(() => {
    if (!mapRef.current || features.length === 0) return;

    const google = window.google;
    const intervalId = setInterval(() => {
      const center = mapRef.current.getCenter();
      if (!center) return;

      const currentPoint = new google.maps.LatLng(center.lat(), center.lng());
      setCurrentCoords({ lat: center.lat(), lng: center.lng() });

      let found = false;
      for (const feature of features) {
        const geometry = feature.getGeometry();
        if (geometry.getType() === 'LineString') {
          const line = geometry;
          const path = line.getArray();

          for (let i = 0; i < path.length - 1; i++) {
            const dist = google.maps.geometry.spherical.computeDistanceBetween(
              currentPoint,
              closestPointOnSegment(currentPoint, path[i], path[i + 1], google)
            );

            if (dist < 20) {
              const name = feature.getProperty('Name');
              setLineName(name);
              found = true;
              break;
            }
          }
          if (found) break;
        }
      }

      if (!found) {
        setLineName(null);
      }
    }, 500); // تحديث كل 500ms لأداء أفضل

    return () => clearInterval(intervalId);
  }, [features]);

  return isLoaded ? (
    <div style={{ 
      position: 'relative',
      height: '100vh',
      width: '100%',
      paddingBottom: 'env(safe-area-inset-bottom)'
    }}>
      <GoogleMap
        mapContainerStyle={containerStyle}
        center={center}
        zoom={15}
        onLoad={handleMapLoad}
        options={{
          gestureHandling: 'greedy',
          disableDoubleClickZoom: true,
          keyboardShortcuts: false,
          fullscreenControl: false,
          streetViewControl: false,
          zoomControlOptions: {
            position: window.google.maps.ControlPosition.LEFT_BOTTOM
          }
        }}
      />

      {/* النقطة الحمراء في المركز */}
      <div
        style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          width: '12px',
          height: '12px',
          backgroundColor: 'red',
          borderRadius: '50%',
          transform: 'translate(-50%, -50%)',
          zIndex: 9999,
          pointerEvents: 'none',
        }}
      />

      {/* مربع عرض المعلومات */}
      <div style={{
        position: 'fixed',
        bottom: safeAreaBottom,
        left: '50%',
        transform: 'translateX(-50%)',
        backgroundColor: 'rgba(255, 255, 255, 0.95)',
        padding: '12px 20px',
        borderRadius: '16px',
        fontFamily: 'sans-serif',
        fontSize: '14px',
        boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
        direction: 'rtl',
        zIndex: 10000,
        maxWidth: '90%',
        textAlign: 'center',
        border: '1px solid #eee',
        backdropFilter: 'blur(5px)'
      }}>
        <div style={{ marginBottom: '4px' }}>
          📍 <strong>الإحداثيات:</strong> {currentCoords.lat.toFixed(6)}, {currentCoords.lng.toFixed(6)}
        </div>
        {lineName && (
          <div style={{ marginTop: '4px' }}>
            📌 <strong>الاسم:</strong> {lineName}
          </div>
        )}
      </div>
    </div>
  ) : (
    <div style={{
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center',
      height: '100vh',
      fontSize: '18px'
    }}>
      جارٍ تحميل الخريطة...
    </div>
  );
}

// دالة مساعدة لحساب أقرب نقطة على قطعة خط
function closestPointOnSegment(p, a, b, google) {
  const dx = b.lng() - a.lng();
  const dy = b.lat() - a.lat();
  const lengthSquared = dx * dx + dy * dy;

  if (lengthSquared === 0) return a;

  const t = ((p.lng() - a.lng()) * dx + (p.lat() - a.lat()) * dy) / lengthSquared;

  if (t < 0) return a;
  if (t > 1) return b;

  return new google.maps.LatLng(a.lat() + t * dy, a.lng() + t * dx);
}

export default MyMap;