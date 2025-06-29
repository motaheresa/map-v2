

import { useRef, useState } from 'react';
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

  const infoWindowRef = useRef(null);

  const [currentCoords, setCurrentCoords] = useState({ lat: 0, lng: 0 });
  const [lineName, setLineName] = useState(null);

  const handleMapLoad = (map) => {
    const google = window.google;
    infoWindowRef.current = new google.maps.InfoWindow();

    fetch('/data.json')
      .then((res) => res.json())
      .then((data) => {
        map.data.addGeoJson(data);

        map.data.setStyle({
          strokeColor: 'blue',
          strokeWeight: 4,
          strokeOpacity: 1,
        });

        const features = [];
        map.data.forEach((feature) => features.push(feature));

        setInterval(() => {
          const center = map.getCenter();
          if (!center) return;

          const currentPoint = new google.maps.LatLng(center.lat(), center.lng());

          // ✅ تحديث الإحداثيات
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
                  setLineName(name); // ✅ عرض الاسم
                  found = true;
                  return;
                }
              }
            }
          }

          if (!found) {
            setLineName(null); // ✅ لو مفيش خط، نخفي الاسم
          }
        }, 1000);
      });
  };

  return isLoaded ? (
    <div style={{ position: 'relative' }}>
      <GoogleMap
        mapContainerStyle={containerStyle}
        center={center}
        zoom={15}
        onLoad={handleMapLoad}
      />
      <CursorDot />

      {/* ✅ عرض الإحداثيات والاسم أسفل الخريطة */}
      <div style={{
        position: 'absolute',
        bottom: 10,
        left: '50%',
        transform: 'translateX(-50%)',
        backgroundColor: 'rgba(255, 255, 255, 0.9)',
        padding: '8px 16px',
        borderRadius: '12px',
        fontFamily: 'sans-serif',
        fontSize: '14px',
        boxShadow: '0 2px 6px rgba(0,0,0,0.2)',
        direction: 'rtl',
        zIndex: 10000
      }}>
        📍 الإحداثيات: {currentCoords.lat.toFixed(6)}, {currentCoords.lng.toFixed(6)} <br />
        {lineName && <>📌 الاسم: {lineName}</>}
      </div>
    </div>
  ) : (
    <div>جارٍ تحميل الخريطة...</div>
  );
}

// 🔴 Red Dot
function CursorDot() {
  return (
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
  );
}

// 🔍 نقطة قريبة من segment
function closestPointOnSegment(
  p,
  a,
  b,
  google
) {
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
