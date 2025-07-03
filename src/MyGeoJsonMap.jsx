import { useRef, useState, useEffect } from 'react';
import { GoogleMap, useJsApiLoader } from '@react-google-maps/api';
import html2canvas from 'html2canvas';

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
  const highlightedFeatureRef = useRef(null);
  const mapRef = useRef(null);
  const [currentCoords, setCurrentCoords] = useState({ lat: 0, lng: 0 });
  const [lineName, setLineName] = useState(null);
  const [distanceFromStart, setDistanceFromStart] = useState(null);
  const [mapType, setMapType] = useState('roadmap');
  const [userLocation, setUserLocation] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [showSearch, setShowSearch] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const searchContainerRef = useRef(null);

  // Handle click outside search to close it
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (searchContainerRef.current && !searchContainerRef.current.contains(event.target)) {
        // Check if the click is not on the search button
        const searchButton = event.target.closest('button');
        if (!searchButton || searchButton.textContent !== '🔍') {
          setShowSearch(false);
        }
      }
    };

    if (showSearch) {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('touchstart', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('touchstart', handleClickOutside);
    };
  }, [showSearch]);

  const handleMapLoad = (map) => {
    const google = window.google;
    infoWindowRef.current = new google.maps.InfoWindow();
    mapRef.current = map;

    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          const pos = {
            lat: position.coords.latitude,
            lng: position.coords.longitude,
          };
          setUserLocation(pos);
          map.panTo(pos);
          map.setZoom(15);
        },
        () => {
          map.panTo(center);
          map.setZoom(15);
        }
      );
    } else {
      map.panTo(center);
      map.setZoom(15);
    }

    fetch('/data.json')
      .then((res) => res.json())
      .then((data) => {
        map.data.addGeoJson(data);

        map.data.setStyle({
          strokeColor: 'blue',
          strokeWeight: 4,
          strokeOpacity: 1,
          zIndex: 1,
        });

        const features = [];
        map.data.forEach((feature) => features.push(feature));

        setInterval(() => {
          const center = map.getCenter();
          if (!center) return;

          const currentPoint = new google.maps.LatLng(center.lat(), center.lng());
          setCurrentCoords({ lat: center.lat(), lng: center.lng() });

          let found = false;

          for (const feature of features) {
            const geometry = feature.getGeometry();
            if (geometry.getType() === 'LineString') {
              const path = geometry.getArray();
              for (let i = 0; i < path.length - 1; i++) {
                const dist = google.maps.geometry.spherical.computeDistanceBetween(
                  currentPoint,
                  closestPointOnSegment(currentPoint, path[i], path[i + 1], google)
                );

                if (dist < 20) {
                  const name = feature.getProperty('Name');
                  setLineName(name);

                  let totalDistance = 0;
                  for (let j = 0; j < i; j++) {
                    totalDistance += google.maps.geometry.spherical.computeDistanceBetween(path[j], path[j + 1]);
                  }
                  totalDistance += google.maps.geometry.spherical.computeDistanceBetween(
                    path[i],
                    closestPointOnSegment(currentPoint, path[i], path[i + 1], google)
                  );
                  setDistanceFromStart((totalDistance / 1000).toFixed(2));

                  if (highlightedFeatureRef.current !== feature && !searchResults.includes(feature)) {
                    if (highlightedFeatureRef.current && !searchResults.includes(highlightedFeatureRef.current)) {
                      map.data.overrideStyle(highlightedFeatureRef.current, {
                        strokeColor: 'blue',
                        strokeWeight: 4,
                        zIndex: 1,
                      });
                    }

                    map.data.overrideStyle(feature, {
                      strokeColor: 'red',
                      strokeWeight: 5,
                      zIndex: 1000,
                    });

                    highlightedFeatureRef.current = feature;
                  }

                  found = true;
                  return;
                }
              }
            }
          }

          if (!found) {
            setLineName(null);
            setDistanceFromStart(null);
            if (highlightedFeatureRef.current && !searchResults.includes(highlightedFeatureRef.current)) {
              map.data.overrideStyle(highlightedFeatureRef.current, {
                strokeColor: 'blue',
                strokeWeight: 4,
                zIndex: 1,
              });
              highlightedFeatureRef.current = null;
            }
          }
        }, 1000);
      });
  };

  const handleSearch = () => {
    if (!mapRef.current || !searchQuery.trim()) {
      resetSearchResults();
      return;
    }

    const query = searchQuery.trim().toLowerCase();
    const results = [];
    
    mapRef.current.data.forEach((feature) => {
      const name = feature.getProperty('Name') || '';
      if (name.toLowerCase().includes(query)) {
        results.push(feature);
        mapRef.current.data.overrideStyle(feature, {
          strokeColor: 'red',
          strokeWeight: 6,
          zIndex: 1000,
        });
      }
    });

    setSearchResults(results);
    
    if (results.length > 0) {
      // Zoom to fit all search results
      const bounds = new window.google.maps.LatLngBounds();
      results.forEach(feature => {
        const geometry = feature.getGeometry();
        if (geometry.getType() === 'LineString') {
          geometry.getArray().forEach(point => bounds.extend(point));
        }
      });
      mapRef.current.fitBounds(bounds);
    }
  };

  const resetSearchResults = () => {
    searchResults.forEach(feature => {
      mapRef.current.data.overrideStyle(feature, {
        strokeColor: 'blue',
        strokeWeight: 4,
        zIndex: 1,
      });
    });
    setSearchResults([]);
    setSearchQuery('');
  };

  const handleGoHome = () => {
    if (mapRef.current && userLocation) {
      mapRef.current.panTo(userLocation);
      mapRef.current.setZoom(15);
    }
  };

  const copyToClipboard = () => {
    const text = `
📍 الإحداثيات: ${currentCoords.lat.toFixed(6)}, ${currentCoords.lng.toFixed(6)}
📌 الاسم: ${lineName || "غير معروف"}
📏 الكيلومتري: ${distanceFromStart || "غير متوفر"} كم
    `.trim();
    navigator.clipboard.writeText(text);
    alert("✅ تم نسخ البيانات بنجاح!");
  };

  const downloadMapImage = async () => {
    if (isDownloading) return;
    
    setIsDownloading(true);
    
    try {
      // Hide control buttons only (keep info box and cursor visible)
      const controlButtons = document.querySelector('.control-buttons');
      const searchContainer = document.querySelector('.search-container');
      
      if (controlButtons) controlButtons.style.display = 'none';
      if (searchContainer) searchContainer.style.display = 'none';
      
      // Wait a moment for UI to hide
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Capture the entire map container (including cursor and info box)
      const mapContainer = document.querySelector('#map-container');
      if (mapContainer) {
        const canvas = await html2canvas(mapContainer, {
          useCORS: true,
          allowTaint: true,
          scale: 1,
          logging: false,
          width: mapContainer.offsetWidth,
          height: mapContainer.offsetHeight
        });
        
        const link = document.createElement('a');
        link.download = `map-${new Date().toISOString().split('T')}.png`;
        link.href = canvas.toDataURL('image/png');
        link.click();
      }
    } catch (error) {
      console.error('Error downloading map:', error);
      alert('خطأ في تحميل الصورة');
    } finally {
      // Show control buttons again
      const controlButtons = document.querySelector('.control-buttons');
      const searchContainer = document.querySelector('.search-container');
      
      if (controlButtons) controlButtons.style.display = '';
      if (searchContainer) searchContainer.style.display = '';
      setIsDownloading(false);
    }
  };

  return isLoaded ? (
    <div id="map-container" style={{ position: 'relative' }}>
      <GoogleMap
        mapContainerStyle={containerStyle}
        center={userLocation || center}
        zoom={15}
        onLoad={handleMapLoad}
        mapTypeId={mapType}
        options={{
          gestureHandling: 'greedy',
          fullscreenControl: false,
          mapTypeControl: false,
          streetViewControl: false,
        }}
      />
      <CursorDot />

      {/* Control Buttons */}
      <div className="control-buttons" style={controlButtonsStyle}>
        <button
          onClick={() => setMapType((prev) => (prev === 'roadmap' ? 'satellite' : 'roadmap'))}
          style={controlButtonStyle}
          title="تغيير نوع الخريطة"
        >
          {mapType === 'roadmap' ? '🛰️' : '🗺️'}
        </button>
        
        <button 
          onClick={copyToClipboard} 
          style={controlButtonStyle}
          title="نسخ البيانات"
        >
          📋
        </button>
        
        <button 
          onClick={downloadMapImage} 
          style={controlButtonStyle}
          disabled={isDownloading}
          title="تحميل صورة الخريطة"
        >
          {isDownloading ? '⏳' : '📷'}
        </button>
        
        <button 
          onClick={handleGoHome} 
          style={controlButtonStyle}
          title="العودة لموقعي"
        >
          🏠
        </button>
        
        <button 
          onClick={() => setShowSearch(!showSearch)}
          style={controlButtonStyle}
          title="البحث"
        >
          🔍
        </button>
      </div>

      {/* Mobile-Responsive Search */}
      {showSearch && (
        <div className="search-container" style={searchContainerStyle} ref={searchContainerRef}>
          <div style={searchBoxStyle}>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="ابحث عن ترعة..."
              style={searchInputStyle}
              onKeyPress={(e) => e.key === 'Enter' && handleSearch()}
            />
            <div style={searchButtonsStyle}>
              <button 
                onClick={handleSearch}
                style={searchActionButtonStyle}
              >
                بحث
              </button>
              {searchResults.length > 0 && (
                <button 
                  onClick={resetSearchResults}
                  style={{...searchActionButtonStyle, color: 'red'}}
                >
                  ✕
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Info Box */}
      <div className="info-box" style={infoBoxStyle}>
        📍 الإحداثيات: {currentCoords.lat.toFixed(6)}, {currentCoords.lng.toFixed(6)} <br />
        {lineName && (
          <>
            📌 الاسم: {lineName} <br />
            📏 الكيلومتري: {distanceFromStart} كم
          </>
        )}
        {searchResults.length > 0 && (
          <div style={{ color: 'red', marginTop: '4px' }}>
            🎯 {searchResults.length} نتيجة بحث
          </div>
        )}
      </div>
    </div>
  ) : (
    <div>جارٍ تحميل الخريطة...</div>
  );
}

// Responsive Styles
const controlButtonsStyle = {
  position: 'absolute',
  top: '10px',
  left: '10px',
  zIndex: 10001,
  display: 'flex',
  flexDirection: window.innerWidth < 768 ? 'row' : 'column',
  gap: '8px',
  flexWrap: 'wrap',
  // Prevent buttons from moving during download
  transform: 'translateZ(0)',
  backfaceVisibility: 'hidden',
};

const controlButtonStyle = {
  backgroundColor: '#fff',
  border: 'none',
  borderRadius: '8px',
  padding: window.innerWidth < 768 ? '8px 10px' : '10px 12px',
  boxShadow: '0 2px 6px rgba(0,0,0,0.2)',
  cursor: 'pointer',
  fontWeight: 'bold',
  fontSize: window.innerWidth < 768 ? '14px' : '16px',
  minWidth: '40px',
  height: '40px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const searchContainerStyle = {
  position: 'absolute',
  top: window.innerWidth < 768 ? '60px' : '10px',
  left: window.innerWidth < 768 ? '10px' : '70px',
  right: window.innerWidth < 768 ? '10px' : 'auto',
  zIndex: 10001,
};

const searchBoxStyle = {
  backgroundColor: '#fff',
  borderRadius: '8px',
  padding: '8px',
  boxShadow: '0 2px 6px rgba(0,0,0,0.2)',
  display: 'flex',
  flexDirection: window.innerWidth < 768 ? 'column' : 'row',
  alignItems: window.innerWidth < 768 ? 'stretch' : 'center',
  gap: '8px',
  minWidth: window.innerWidth < 768 ? 'auto' : '300px',
};

const searchInputStyle = {
  border: '1px solid #ddd',
  borderRadius: '4px',
  padding: '8px',
  outline: 'none',
  direction: 'rtl',
  fontSize: '14px',
  flex: 1,
  minWidth: window.innerWidth < 768 ? '100%' : '200px',
};

const searchButtonsStyle = {
  display: 'flex',
  gap: '4px',
  flexShrink: 0,
};

const searchActionButtonStyle = {
  border: 'none',
  background: '#007bff',
  color: 'white',
  borderRadius: '4px',
  padding: '6px 12px',
  cursor: 'pointer',
  fontSize: '12px',
  whiteSpace: 'nowrap',
};

const infoBoxStyle = {
  position: 'fixed',
  bottom: '10px',
  left: '50%',
  transform: 'translateX(-50%)',
  backgroundColor: 'rgba(255, 255, 255, 0.95)',
  padding: window.innerWidth < 768 ? '6px 12px' : '8px 16px',
  borderRadius: '12px',
  fontFamily: 'sans-serif',
  fontSize: window.innerWidth < 400 ? '11px' : window.innerWidth < 768 ? '12px' : '14px',
  boxShadow: '0 2px 6px rgba(0,0,0,0.2)',
  direction: 'rtl',
  zIndex: 10001,
  minWidth: window.innerWidth < 768 ? '250px' : '280px',
  maxWidth: '95%',
  textAlign: 'center',
  lineHeight: '1.4',
};

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