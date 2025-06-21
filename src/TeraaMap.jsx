import { useState, useEffect, useRef, useCallback, memo } from 'react';
import { MapContainer, TileLayer, Polyline, Popup, Marker, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import RBush from 'rbush'; // Import RBush for spatial indexing

// --- Utility Functions (Outside of Components) ---

/**
 * Debounce function to limit how often a function is called.
 * It waits for a specified delay after the last call before executing.
 */
function debounce(func, delay) {
  let timeout;
  return function(...args) {
    const context = this;
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(context, args), delay);
  };
}

/**
 * Throttle function to limit how often a function is called.
 * It executes the function at most once within a given time frame.
 */
function throttle(func, limit) {
  let inThrottle;
  let lastResult;
  let lastRan;
  return function(...args) {
    const context = this;
    if (!lastRan) {
      func.apply(context, args);
      lastRan = Date.now();
    } else {
      clearTimeout(inThrottle);
      inThrottle = setTimeout(function() {
        if ((Date.now() - lastRan) >= limit) {
          lastResult = func.apply(context, args);
          lastRan = Date.now();
        }
      }, limit - (Date.now() - lastRan));
    }
    return lastResult;
  };
}

// Default center (Saudi Arabia region from the screenshot)
const defaultCenter = [22.3964614, 34.8516932];

// Custom icon for the user's current location (arrow)
const createUserLocationIcon = (rotationAngle = 0) => {
  return L.divIcon({
    className: 'custom-user-icon',
    html: `<img src="https://cdn-icons-png.flaticon.com/512/447/447031.png" style="transform: rotate(${rotationAngle}deg); width: 32px; height: 32px;" />`,
    iconSize: [32, 32],
    iconAnchor: [16, 16],
  });
};

/**
 * Calculates the distance between two geographical coordinates using the Haversine formula.
 */
function calculateDistance(coord1, coord2) {
  const toRad = (value) => (value * Math.PI) / 180;

  const [lat1, lon1] = coord1;
  const [lat2, lon2] = coord2;

  const R = 6371; // Earth's radius in km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Calculates the bearing (direction) from point 1 to point 2.
 */
function calculateBearing(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => deg * Math.PI / 180;
  const toDeg = (rad) => rad * 180 / Math.PI;

  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);

  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  const θ = Math.atan2(y, x);
  let bearing = toDeg(θ);
  return (bearing + 360) % 360;
}

/**
 * Check if a point is inside a polygon using ray casting algorithm
 * Point format: [lat, lng]
 * Polygon format: [[lat, lng], [lat, lng], ...]
 */
function isPointInPolygon(point, polygon) {
  const [x, y] = point; // point is [lat, lng]
  let inside = false;

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];

    // Check if the ray from point (x,y) crosses the segment (xi,yi)-(xj,yj)
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Check if a point is near a line (within a certain distance)
 * Point format: [lat, lng]
 * LineCoords format: [[lng, lat], [lng, lat], ...] (GeoJSON standard)
 */
function isPointNearLine(point, lineCoords, tolerance = 0.001) {
  const [pointLat, pointLng] = point;

  for (let i = 0; i < lineCoords.length - 1; i++) {
    // GeoJSON coordinates are [lng, lat], convert to [lat, lng] for calculation
    const [lng1, lat1] = lineCoords[i];
    const [lng2, lat2] = lineCoords[i + 1];

    // Calculate distance from point to line segment
    const distance = distanceToLineSegment(pointLat, pointLng, lat1, lng1, lat2, lng2);
    if (distance < tolerance) {
      return true;
    }
  }
  return false;
  }

/**
 * Calculate distance from a point to a line segment
 */
function distanceToLineSegment(px, py, x1, y1, x2, y2) {
  let dx = x2 - x1;
  let dy = y2 - y1;

  if (dx !== 0 || dy !== 0) {
    let t = ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy);

    if (t > 1) {
      dx = px - x2;
      dy = py - y2;
    } else if (t > 0) {
      dx = px - (x1 + dx * t);
      dy = py - (y1 + dy * t);
    } else {
      dx = px - x1;
      dy = py - y1;
    }
  } else {
    dx = px - x1;
    dy = py - y1;
  }
  return Math.sqrt(dx * dx + dy * dy);
}

// --- React Components ---

/**
 * Component to track map center and update coordinates
 * Utilizes RBush for efficient spatial queries on GeoJSON data.
 * Debounces calls to checkGeoJSONLocation for real-time updates during map move.
 * Throttles Nominatim API calls to prevent rate limiting.
 */
const MapCenterTracker = ({ setCenterCoordinates, setLocationInfo, geojson }) => {
  const rbushRef = useRef(null); // Ref to store our spatial index

  // Build the spatial index whenever geojson data changes
  useEffect(() => {
    if (geojson && geojson.features) {
      const tree = new RBush();
      const items = geojson.features.map(feature => {
        // Calculate bounding box for each feature.
        // L.GeoJSON can help with this, creating a temporary layer.
        const leafletLayer = L.geoJSON(feature);
        const featureBounds = leafletLayer.getBounds();

        if (featureBounds.isValid()) {
          // RBush expects [minX, minY, maxX, maxY]
          // Leaflet bounds are [south, west] - [north, east]
          // So, minX=west, minY=south, maxX=east, maxY=north
          return {
            minX: featureBounds.getWest(),
            minY: featureBounds.getSouth(),
            maxX: featureBounds.getEast(),
            maxY: featureBounds.getNorth(),
            feature: feature // Store the actual feature data for later precise checks
          };
        }
        return null; // Skip invalid features
      }).filter(Boolean); // Filter out any nulls

      tree.load(items);
      rbushRef.current = tree;
    } else {
      rbushRef.current = null; // Clear index if no geojson
    }
  }, [geojson]);

  // Function to check location against GeoJSON using spatial index
  const checkGeoJSONLocation = useCallback((lat, lng) => {
    if (!rbushRef.current) return null;

    // Create a small search envelope around the point [lng, lat]
    // A small buffer (e.g., 0.0001 degrees) is often good to catch features near the point.
    const searchTolerance = 0.0001; // Adjust this value as needed
    const searchBounds = {
        minX: lng - searchTolerance,
        minY: lat - searchTolerance,
        maxX: lng + searchTolerance,
        maxY: lat + searchTolerance
    };

    // Query the spatial index for features whose bounding boxes overlap with the search point
    const potentialFeatures = rbushRef.current.search(searchBounds);

    // Now, perform precise (and more expensive) point-in-polygon/line checks
    // only on the *potential* features returned by the index.
    const point = [lat, lng]; // For isPointInPolygon/isPointNearLine

    for (const item of potentialFeatures) {
      const feature = item.feature;
      if (!feature.geometry || !feature.properties) continue;

      const { geometry, properties } = feature;
      const featureName = properties.name || properties.NAME || properties.title;

      if (!featureName) continue;

      switch (geometry.type) {
        case 'Polygon':
          // GeoJSON coords are [lng, lat], convert to [lat, lng] for isPointInPolygon
          const polygonCoords = geometry.coordinates[0].map(([lng, lat]) => [lat, lng]);
          if (isPointInPolygon(point, polygonCoords)) {
            return featureName;
          }
          break;

        case 'MultiPolygon':
          for (const polygon of geometry.coordinates) {
            const polygonCoords = polygon[0].map(([lng, lat]) => [lat, lng]);
            if (isPointInPolygon(point, polygonCoords)) {
              return featureName;
            }
          }
          break;

        case 'LineString':
          if (isPointNearLine(point, geometry.coordinates)) {
            return featureName;
          }
          break;

        case 'MultiLineString':
          for (const line of geometry.coordinates) {
            if (isPointNearLine(point, line)) {
              return featureName;
            }
          }
          break;

        case 'Point':
          const [pointLng, pointLat] = geometry.coordinates;
          const distance = calculateDistance([lat, lng], [pointLat, pointLng]);
          if (distance < 0.01) { // Within 10 meters
            return featureName;
          }
          break;
      }
    }
    return null;
  }, []); // Dependencies are stable (rbushRef is a ref, its value changes but ref itself is stable)

  // Debounced version for 'move' event (for real-time GeoJSON checks)
  const checkGeoJSONLocationDebounced = useRef(
    debounce((lat, lng) => {
      const geojsonName = checkGeoJSONLocation(lat, lng);
      if (geojsonName) {
        setLocationInfo({
          name: `${geojsonName} (من البيانات المحلية)`,
          coordinates: `${lat.toFixed(8)}, ${lng.toFixed(8)}`,
          isFromGeoJSON: true
        });
      }
    }, 150) // Adjust debounce time (e.g., 50ms, 100ms, 200ms) for responsiveness
  ).current; // .current ensures the debounced function reference is stable

  // NEW: Debounced version for setting center coordinates
  const setCenterCoordinatesDebounced = useRef(
    debounce((lat, lng) => {
      setCenterCoordinates([lat, lng]);
    }, 50) // Adjust this debounce time (e.g., 50ms, 100ms, 200ms)
            // Smaller delay for a more responsive coordinate display, larger for more performance gain
  ).current;

  // Throttled version for Nominatim API calls
  const throttledNominatimCall = useRef(
    throttle(async (lat, lng) => {
      try {
        const response = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=14&addressdetails=1`);
        const data = await response.json();
        const locationName = data.display_name || `${lat.toFixed(8)}, ${lng.toFixed(8)}`;
        setLocationInfo({
          name: locationName,
          coordinates: `${lat.toFixed(8)}, ${lng.toFixed(8)}`,
          isFromGeoJSON: false
        });
      } catch (error) {
        console.error('Error with Nominatim reverse geocoding:', error);
        // Fallback to coordinates if API call fails
        setLocationInfo({
          name: `${lat.toFixed(8)}, ${lng.toFixed(8)}`,
          coordinates: `${lat.toFixed(8)}, ${lng.toFixed(8)}`,
          isFromGeoJSON: false
        });
      }
    }, 1000) // Throttle to 1 call per second for Nominatim API
  ).current;

  const map = useMapEvents({
    moveend: () => { // Async not needed directly on event listener
      const center = map.getCenter();
      const lat = center.lat;
      const lng = center.lng;

      // On moveend, always set the final coordinates immediately for accuracy
      setCenterCoordinates([lat, lng]); // No debounce here, get final exact coordinates

      const geojsonName = checkGeoJSONLocation(lat, lng);

      if (geojsonName) {
        setLocationInfo({
          name: `${geojsonName} (من البيانات المحلية)`,
          coordinates: `${lat.toFixed(8)}, ${lng.toFixed(8)}`,
          isFromGeoJSON: true
        });
      } else {
        // Use the throttled Nominatim call here if no local feature is found
        throttledNominatimCall(lat, lng);
      }
    },
    move: () => {
      const center = map.getCenter();
      const lat = center.lat;
      const lng = center.lng;

      // Use the debounced function for updating the displayed coordinates
      setCenterCoordinatesDebounced(lat, lng);

      // Use the debounced function to check GeoJSON location during move
      checkGeoJSONLocationDebounced(lat, lng);
    }
  });

  return null;
};

/**
 * Component to load and display GeoJSON layers efficiently.
 * Wrapped with React.memo for performance optimization.
 */
const GeoJSONLayerComponent = memo(({ data, onPolylineClick, highlightedFeature }) => {
  const map = useMap();
  const geoJsonLayerRef = useRef(null);

  // Function to style GeoJSON features
  // useCallback memoizes this function, only recreating if highlightedFeature changes
  const style = useCallback((feature) => {
    const isHighlighted = highlightedFeature &&
                          feature.properties && highlightedFeature.properties &&
                          feature.properties.name === highlightedFeature.properties.name;
    return {
      color: isHighlighted ? 'red' : 'blue',
      weight: isHighlighted ? 5 : 3,
      opacity: 0.8
    };
  }, [highlightedFeature]);

  // Function to handle interactions with GeoJSON features
  // useCallback memoizes this function, only recreating if onPolylineClick changes
  const onEachFeature = useCallback((feature, layer) => {
    if (feature.properties && feature.properties.name) {
      const popupContent = `
        <div>
          <strong>الاسم:</strong> ${feature.properties.name || 'غير معروف'}<br />
          <strong>عدد النقاط:</strong> ${feature.geometry.coordinates.length}
        </div>
      `;
      layer.bindPopup(popupContent);
    }

    layer.on({
      click: (e) => {
        // Ensure the click event also triggers the onPolylineClick prop
        if (onPolylineClick) {
          onPolylineClick({
            name: feature.properties.name || 'غير معروف',
            coords: [e.latlng.lat, e.latlng.lng],
            feature: feature,
          });
        }
      }
    });
  }, [onPolylineClick]);

  useEffect(() => {
    if (map && data) {
      // Remove existing GeoJSON layer if it exists
      if (geoJsonLayerRef.current) {
        map.removeLayer(geoJsonLayerRef.current);
      }

      // Create new L.geoJSON layer with provided data, style, and interaction handlers
      geoJsonLayerRef.current = L.geoJSON(data, {
        style: style,
        onEachFeature: onEachFeature
      }).addTo(map);

      // Fit map bounds to GeoJSON data on initial load or data change
      const bounds = geoJsonLayerRef.current.getBounds();
      if (bounds.isValid()) {
        map.fitBounds(bounds, { padding: [50, 50] });
      }
    }

    // Clean up when component unmounts or data changes
    return () => {
      if (map && geoJsonLayerRef.current) {
        map.removeLayer(geoJsonLayerRef.current);
      }
    };
  }, [map, data, style, onEachFeature]); // Re-run effect if data or styling/interaction functions change

  // This effect updates the style of existing layers when highlightedFeature changes
  // It iterates over layers instead of recreating the whole GeoJSON layer
  useEffect(() => {
    if (geoJsonLayerRef.current) {
      geoJsonLayerRef.current.eachLayer(layer => {
        const feature = layer.feature;
        const newStyle = style(feature); // Use the memoized style function to get new style
        layer.setStyle(newStyle); // Apply the new style to the individual layer
      });
    }
  }, [highlightedFeature, style]); // Re-run if highlightedFeature or style function changes

  return null;
});


/**
 * Component to track and update user's geographical location.
 */
const LocationTracker = ({ setUserLocation, setRotationAngle }) => {
  const lastPositionRef = useRef(null);

  useEffect(() => {
    // Watch for changes in the user's geolocation
    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        const { latitude, longitude } = position.coords;
        const newPosition = [latitude, longitude];

        // Calculate bearing only if a previous position exists and it's a new position
        if (lastPositionRef.current && (lastPositionRef.current[0] !== newPosition[0] || lastPositionRef.current[1] !== newPosition[1])) {
          const bearing = calculateBearing(
            lastPositionRef.current[0],
            lastPositionRef.current[1],
            newPosition[0],
            newPosition[1]
          );
          setRotationAngle(bearing);
        } else if (!lastPositionRef.current) {
          // If it's the first position, set rotation to 0 (North)
          setRotationAngle(0);
        }

        setUserLocation(newPosition);
        lastPositionRef.current = newPosition;
      },
      (err) => {
        console.error('Error getting user location:', err);
      },
      // Geolocation options for high accuracy
      { enableHighAccuracy: true, maximumAge: 0, timeout: 5000 }
    );

    // Clean up by clearing the watch when the component unmounts
    return () => navigator.geolocation.clearWatch(watchId);
  }, [setUserLocation, setRotationAngle]);

  return null;
};

// Main TeraaMap React Component
export default function TeraaMap() {
  // State variables for map data and UI controls
  const [geojson, setGeojson] = useState(null);
  const [loading, setLoading] = useState(true);
  const [userLocation, setUserLocation] = useState(null);
  const [rotationAngle, setRotationAngle] = useState(0); // For user location marker orientation
  const [mapType, setMapType] = useState('roadmap'); // 'roadmap' or 'satellite'
  const [searchedPlaceInput, setSearchedPlaceInput] = useState('');
  const [highlightedFeature, setHighlightedFeature] = useState(null); // The currently selected GeoJSON feature
  const [centerCoordinates, setCenterCoordinates] = useState(defaultCenter); // Coordinates displayed at the bottom
  const [locationInfo, setLocationInfo] = useState(null); // Name of the location at map center
  const [searchResultInfo, setSearchResultInfo] = useState(null); // Info about a searched/clicked place
  const [showSearchInput, setShowSearchInput] = useState(false); // State to control search input visibility

  const mapRef = useRef(null); // Reference to the Leaflet map instance

  // Fetch GeoJSON data on component mount
  useEffect(() => {
    // Fetch the simplified and uncompressed GeoJSON file
    fetch('/result_more_simplified.geojson')
      .then(res => {
        if (!res.ok) {
          throw new Error(`HTTP error! status: ${res.status}`)
        }
        return res.json();
      })
      .then(data => {
        setGeojson(data);
        setLoading(false);
      })
      .catch(err => {
        console.error('Error loading geojson:', err);
        setLoading(false);
        // Use a custom message box instead of alert in production
        alert('حدث خطأ أثناء تحميل بيانات الخريطة.');
      });
  }, []); // Empty dependency array ensures this runs once on mount

  // Callback for when a polyline (GeoJSON feature) is clicked
  const handlePolylineClick = useCallback(({ name, coords, feature }) => {
    setHighlightedFeature(feature); // Highlight the clicked feature
    const map = mapRef.current;
    if (map && feature.geometry.coordinates.length > 0) {
      // GeoJSON coordinates are [lng, lat], convert to [lat, lng] for Leaflet
      const startCoord = feature.geometry.coordinates[0].slice().reverse(); // [lat, lng]
      map.setView(startCoord, 14); // Pan and zoom to the start of the feature

      // Set search result info for the clicked feature
      setSearchResultInfo({
        name: name,
        coordinates: `${startCoord[0].toFixed(8)}, ${startCoord[1].toFixed(8)}`,
        feature: feature
      });
    }
  }, []);

  // Callback to toggle map tile layer type (roadmap or satellite)
  const handleMapTypeChange = useCallback(() => {
    setMapType(prevType => (prevType === 'roadmap' ? 'satellite' : 'roadmap'));
  }, []);

  // Callback to pan the map to the user's current location
  const handleGoHome = useCallback(() => {
    const map = mapRef.current;
    if (map && userLocation) {
      map.setView(userLocation, 15); // Pan and zoom to user location
    } else {
      // Use a custom message box instead of alert in production
      alert('لا يتوفر موقع المستخدم حاليًا لتركز عليه الخريطة.');
    }
  }, [userLocation]);

  // Callback to copy map center coordinates to clipboard
  const handleCopyCoordinates = useCallback(() => {
    if (centerCoordinates) {
      const coordsString = `${centerCoordinates[0].toFixed(8)}, ${centerCoordinates[1].toFixed(8)}`;
      try {
        const textarea = document.createElement('textarea');
        textarea.value = coordsString;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy'); // Deprecated but widely supported for iframes
        document.body.removeChild(textarea);
        // Use a custom message box instead of alert in production
        alert('تم نسخ الإحداثيات!');
      } catch (err) {
        console.error('Failed to copy text: ', err);
        // Use a custom message box instead of alert in production
        alert('فشل نسخ الإحداثيات.');
      }
    }
  }, [centerCoordinates]);

  // Callback to search for a place within the loaded GeoJSON data
  const handleSearch = useCallback(() => {
    if (!geojson || !searchedPlaceInput.trim()) {
      setHighlightedFeature(null);
      setSearchResultInfo(null);
      return;
    }

    const searchTerm = searchedPlaceInput.trim().toLowerCase();

    // Find a feature whose name (or other properties) includes the search term
    const foundFeature = geojson.features.find(feature => {
      if (!feature.properties) return false;

      const name = feature.properties.name || feature.properties.NAME || feature.properties.title || '';
      return name.toLowerCase().includes(searchTerm);
    });

    if (foundFeature) {
      setHighlightedFeature(foundFeature); // Highlight the found feature

      const map = mapRef.current;
      if (map && foundFeature.geometry.coordinates.length > 0) {
        // Get the first coordinate of the feature (GeoJSON is [lng, lat])
        const startCoord = foundFeature.geometry.coordinates[0].slice().reverse(); // [lat, lng]

        map.setView(startCoord, 14); // Pan and zoom to the found feature

        // Set search result information
        const featureName = foundFeature.properties.name || foundFeature.properties.NAME || foundFeature.properties.title || 'غير معروف';
        setSearchResultInfo({
          name: featureName,
          coordinates: `${startCoord[0].toFixed(8)}, ${startCoord[1].toFixed(8)}`,
          feature: foundFeature
        });

        // Update main location info to show the found place
        setLocationInfo({
          name: `${featureName} (تم العثور عليه)`,
          coordinates: `${startCoord[0].toFixed(8)}, ${startCoord[1].toFixed(8)}`,
          isFromGeoJSON: true
        });

        setSearchedPlaceInput(''); // Clear search input after successful search
        setShowSearchInput(false); // Close search input after successful search
      }
    } else {
      setHighlightedFeature(null);
      setSearchResultInfo(null);
      // Use a custom message box instead of alert in production
      alert(`لم يتم العثور على "${searchedPlaceInput}"!`);
    }
  }, [geojson, searchedPlaceInput]);

  // Handle Enter key press in search input to trigger search
  const handleSearchKeyPress = useCallback((e) => {
    if (e.key === 'Enter') {
      handleSearch();
    }
  }, [handleSearch]);

  // Show loading message while GeoJSON data is being fetched
  if (loading) return <div className="text-center mt-4 text-lg font-semibold text-gray-700">جاري تحميل البيانات...</div>;

  // Create the custom icon for the user's location marker with current rotation
  const currentUserLocationIcon = createUserLocationIcon(rotationAngle);

  // Calculate coordinates for the highlighted feature (for marker and distance)
  const highlightedCoords = highlightedFeature && highlightedFeature.geometry.coordinates.length > 0
    ? highlightedFeature.geometry.coordinates[0].slice().reverse() // [lat, lng]
    : null;

  // Calculate distance between user and highlighted feature
  const distanceToHighlighted = (userLocation && highlightedCoords)
    ? calculateDistance(userLocation, highlightedCoords).toFixed(2)
    : 'N/A';

  return (
    <div className="w-full h-screen relative flex flex-col">
      {/* Top Controls Panel (Icons) */}
      <div className="absolute top-4 right-4 z-[1000] p-2 bg-white rounded-md shadow-lg flex flex-col space-y-2 md:flex-row md:space-x-2 md:space-y-0">
        {/* Map Type Toggle */}
        <button
          onClick={handleMapTypeChange}
          className="p-2 bg-blue-600 text-white rounded-full shadow-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-opacity-50 transition duration-200"
          title={mapType === 'roadmap' ? 'عرض القمر الصناعي' : 'عرض الخريطة'}
        >
          {mapType === 'roadmap' ? (
            // Satellite Icon
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M6.105 8.655A.5.5 0 0 1 6 8.5v-1A.5.5 0 0 1 6.105 7c.451-.9 1.402-1.336 2.527-1.336h.619c.773 0 1.442.305 1.867.8l.016.01c.21.21.36.463.454.747L12 12m2.848-2.849a.5.5 0 0 1 .152.349V15m-1.243-3.083 3.693 3.693M11 5.5h-.619c-1.125 0-2.076.436-2.527 1.336-.057.114-.083.24-.075.367a.5.5 0 0 1 .105.348v1A.5.5 0 0 1 8.895 9c-.451.9-1.402 1.336-2.527 1.336H5m-2.257-3.95L5 9.475m10.125-3.694c.3-.294.597-.563.896-.807.45-.365.88-.696 1.285-.99.405-.293.774-.534 1.1-.72A2.247 2.247 0 0 1 20.25 5c.83 0 1.5.671 1.5 1.5 0 .82-.67 1.491-1.488 1.5-.07-.006-.136-.017-.202-.031a.5.5 0 0 0-.5.495v.373a.5.5 0 0 0 .15.349l3.69 3.69M20.25 15V9.75M17.25 17.25H6.75A2.25 2.25 0 0 0 4.5 19.5v1.25c0 .138.112.25.25.25H19.5c.138 0 .25-.112.25-.25V19.5a2.25 2.25 0 0 0-2.25-2.25Z" /></svg>
          ) : (
            // Map (Roadmap) Icon
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M9 6.75V15m6-6v8.25m.5 1.5H9.75M21 12c0 1.268-.63 2.473-1.688 3.122A11.53 11.53 0 0 1 12 18.75c-2.514 0-4.834-.694-6.705-1.873A11.53 11.53 0 0 1 3 12c0-1.268.63-2.473 1.688-3.122A11.53 11.53 0 0 1 12 5.25c2.514 0 4.834.694 6.705 1.873A11.53 11.53 0 0 1 21 12Z" /></svg>
          )}
        </button>

        {/* Go to Home (User Location) */}
        <button
          onClick={handleGoHome}
          className="p-2 bg-green-600 text-white rounded-full shadow-md hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-opacity-50 transition duration-200"
          title="العودة للمنزل"
        >
          {/* Home icon */}
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="m2.25 12 8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125h9.75a1.125 1.125 0 0 0 1.125-1.125V9.75M8.25 21.75h7.5" /></svg>
        </button>

        {/* Search Toggle Button */}
        <button
          onClick={() => setShowSearchInput(prev => !prev)}
          className="p-2 bg-indigo-600 text-white rounded-full shadow-md hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-opacity-50 transition duration-200"
          title="بحث"
        >
          {/* Search icon */}
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" /></svg>
        </button>
      </div>

      {/* Search Input Overlay */}
      {showSearchInput && (
        <div className="absolute top-4 left-4 right-4 z-[1000] p-2 bg-white rounded-md shadow-lg flex items-center space-x-2">
          <input
            type="text"
            placeholder="البحث عن مكان..."
            value={searchedPlaceInput}
            onChange={(e) => setSearchedPlaceInput(e.target.value)}
            onKeyPress={handleSearchKeyPress}
            className="flex-grow p-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            onClick={handleSearch}
            className="p-2 bg-indigo-600 text-white rounded-full shadow-md hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-opacity-50 transition duration-200"
            title="بحث"
          >
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" /></svg>
          </button>
          <button
            onClick={() => setShowSearchInput(false)}
            className="p-2 bg-gray-600 text-white rounded-full shadow-md hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-opacity-50 transition duration-200"
            title="إغلاق البحث"
          >
            {/* Close icon */}
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
          </button>
        </div>
      )}

      {/* Search Result Info Panel (Responsive) */}
      {searchResultInfo && (
        <div className="absolute top-20 md:top-4 md:left-4 z-[1000] p-3 bg-white rounded-md shadow-lg w-[calc(100%-2rem)] md:max-w-sm">
          <div className="flex items-center justify-between mb-1">
            <h3 className="text-base md:text-lg font-bold text-green-600">تم العثور على المكان</h3>
            <button
              onClick={() => setSearchResultInfo(null)}
              className="text-gray-500 hover:text-gray-700 p-1 rounded-full hover:bg-gray-100"
              title="إغلاق"
            >
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
            </button>
          </div>
          <div className="space-y-1 text-sm md:text-base">
            <div>
              <span className="font-semibold text-gray-700">الاسم: </span>
              <span className="text-red-600 font-bold">{searchResultInfo.name}</span>
            </div>
            <div>
              <span className="font-semibold text-gray-700">الإحداثيات: </span>
              <span className="font-mono text-xs md:text-sm">{searchResultInfo.coordinates}</span>
            </div>
            {userLocation && (
              <div>
                <span className="font-semibold text-gray-700">المسافة من موقعك: </span>
                <span className="text-blue-600 font-bold">{distanceToHighlighted} كم</span>
              </div>
            )}
            <div className="flex space-x-2 mt-2">
              <button
                onClick={() => {
                  const coordsString = searchResultInfo.coordinates;
                  const textarea = document.createElement('textarea');
                  textarea.value = coordsString;
                  document.body.appendChild(textarea);
                  textarea.select();
                  document.execCommand('copy');
                  document.body.removeChild(textarea);
                  alert('تم نسخ إحداثيات المكان!');
                }}
                className="p-2 bg-blue-600 text-white rounded-full shadow-md hover:bg-blue-700 transition duration-200"
                title="نسخ الإحداثيات"
              >
                {/* Copy Icon */}
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 0 1-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75m10.875 0V6.75a1.125 1.125 0 0 0-1.125-1.125H9.75A1.125 1.125 0 0 0 8.625 6.75v.375m.375 0H18A2.25 2.25 0 0 1 20.25 9v10.5A2.25 2.25 0 0 1 18 21.75H9.75A2.25 2.25 0 0 1 7.5 19.5V9a2.25 2.25 0 0 1 2.25-2.25Z" /></svg>
              </button>
            </div>
          </div>
        </div>
      )}


      {/* Crosshair at the center of the map */}
      <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 z-[1000] pointer-events-none">
        <div className="relative">
          {/* Main crosshair circle */}
          <div className="w-8 h-8 border-2 border-red-500 rounded-full bg-white bg-opacity-80 flex items-center justify-center">
            <div className="w-2 h-2 bg-red-500 rounded-full"></div>
          </div>
          {/* Crosshair lines */}
          <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2">
            <div className="w-12 h-0.5 bg-red-500 absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2"></div>
            <div className="w-0.5 h-12 bg-red-500 absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2"></div>
          </div>
        </div>
      </div>

      {/* Main Map Container */}
      <MapContainer
        center={defaultCenter}
        zoom={8} // Initial zoom level
        scrollWheelZoom={true} // Enable mouse wheel zooming
        className="flex-grow w-full h-full" // Occupy full available space
        whenCreated={mapInstance => mapRef.current = mapInstance} // Get reference to Leaflet map instance
      >
        {/* Conditional TileLayer based on mapType state */}
        {mapType === 'roadmap' ? (
          <TileLayer
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            attribution="&copy; OpenStreetMap contributors"
          />
        ) : (
          <TileLayer
            url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
            attribution="Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community"
          />
        )}

        {/* Map center tracking component */}
        <MapCenterTracker
          setCenterCoordinates={setCenterCoordinates}
          setLocationInfo={setLocationInfo}
          geojson={geojson}
        />

        {/* GeoJSON layer component, only rendered when data is available */}
        {geojson && <GeoJSONLayerComponent data={geojson} onPolylineClick={handlePolylineClick} highlightedFeature={highlightedFeature} />}

        {/* User location tracking component */}
        <LocationTracker setUserLocation={setUserLocation} setRotationAngle={setRotationAngle} />

        {/* User's current location marker */}
        {userLocation && (
          <Marker position={userLocation} icon={currentUserLocationIcon}>
            <Popup>
              <div>
                <strong>موقعك الحالي:</strong><br />
                {userLocation[0].toFixed(5)}, {userLocation[1].toFixed(5)}
              </div>
            </Popup>
          </Marker>
        )}

        {/* Marker for the highlighted/searched feature */}
        {highlightedFeature && highlightedCoords && (
          <Marker position={highlightedCoords}>
            <Popup>
              <div>
                <strong>المكان المحدد:</strong> {highlightedFeature.properties.name || 'غير معروف'}<br />
                <strong>الإحداثيات (البداية):</strong><br />
                {highlightedCoords[0].toFixed(5)}, {highlightedCoords[1].toFixed(5)}<br />
                <strong>المسافة من موقعك:</strong> {distanceToHighlighted} كم
              </div>
            </Popup>
          </Marker>
        )}

        {/* Polyline connecting user location to highlighted feature */}
        {userLocation && highlightedCoords && (
          <Polyline positions={[userLocation, highlightedCoords]} color="purple" weight={2} opacity={0.7} dashArray="5, 10" />
        )}
      </MapContainer>

      {/* Bottom Coordinates and Info Panel */}
      <div className="absolute bottom-0 left-0 right-0 z-[1000] bg-black bg-opacity-90 text-white p-3 md:p-4">
        <div className="flex flex-col md:flex-row justify-between items-center space-y-2 md:space-y-0">
          {/* Coordinates Display */}
          <div className="flex flex-col md:flex-row space-y-1 md:space-y-0 md:space-x-4 text-xs md:text-lg">
            <div className="font-mono">
              <span className="text-gray-300">Latitude = </span>
              <span className="text-white font-bold">{centerCoordinates[0].toFixed(8)}</span>
            </div>
            <div className="font-mono">
              <span className="text-gray-300">Longitude = </span>
              <span className="text-white font-bold">{centerCoordinates[1].toFixed(8)}</span>
            </div>
          </div>

          {/* Action Buttons (Icons) */}
          <div className="flex space-x-2">
            <button
              onClick={handleCopyCoordinates}
              className="p-2 bg-blue-600 text-white rounded-full shadow-md hover:bg-blue-700 transition duration-200"
              title="نسخ الإحداثيات"
            >
              {/* Copy Icon */}
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 0 1-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75m10.875 0V6.75a1.125 1.125 0 0 0-1.125-1.125H9.75A1.125 1.125 0 0 0 8.625 6.75v.375m.375 0H18A2.25 2.25 0 0 1 20.25 9v10.5A2.25 2.25 0 0 1 18 21.75H9.75A2.25 2.25 0 0 1 7.5 19.5V9a2.25 2.25 0 0 1 2.25-2.25Z" /></svg>
            </button>
            <button
              className="p-2 bg-red-600 text-white rounded-full shadow-md hover:bg-red-700 transition duration-200"
              title="آلة حاسبة"
            >
              {/* Calculator Icon */}
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25m-10.5 0h10.5M19.5 6.75V19.5a2.25 2.25 0 0 1-2.25 2.25H6.75A2.25 2.25 0 0 1 4.5 19.5V6.75M13.5 10.5h.008v.008h-.008V10.5Zm-4.5 0h.008v.008H9V10.5Zm-4.5 0h.008v.008H4.5V10.5Zm9 3h.008v.008h-.008V13.5Zm-4.5 0h.008v.008H9V13.5Zm-4.5 0h.008v.008H4.5V13.5Zm9 3h.008v.008h-.008V16.5Zm-4.5 0h.008v.008H9V16.5Zm-4.5 0h.008v.008H4.5V16.5Z" /></svg>
            </button>
          </div>
        </div>

        {/* Location Name Display */}
        {locationInfo && (
          <div className="mt-2 flex items-center space-x-2">
            <div className="text-sm md:text-base text-gray-300 truncate flex-1">
              📍 {locationInfo.name}
            </div>
            {locationInfo.isFromGeoJSON && (
              <div className="bg-green-600 text-white px-2 py-1 rounded text-xs font-semibold">
                محلي
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}