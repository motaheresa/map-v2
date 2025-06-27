import React, { useState, useEffect, useCallback, useRef } from 'react';
import { MapPin, Copy, Download, Home } from 'lucide-react';

// Using the initialMapCenter that was adjusted to be near your GeoJSON data
const initialMapCenter = {
  lat: 30.885, // Approximately central latitude for the 'جرارا معنيا' line
  lng: 30.625 // Approximately central longitude for the 'جرارا معنيا' line
};

// Define a maximum distance (in kilometers) to consider a point "on" or "near" a line
// Setting to 20km for robust testing to ensure initial detection
const MAX_DISTANCE_TO_LINE_KM = 20.0; 

// Debounce delay in milliseconds for location updates
const DEBOUNCE_DELAY_MS = 150; 

// --- Embedded KDBush Start ---
class KDBush {
  constructor(points) {
    this.points = points; 
    this.ids = [];
    this.coords = [];
    this.tree = []; 
    this.nodeSize = 64; 
    this.init();
  }

  init() {
    for (let i = 0; i < this.points.length; i++) {
      this.ids[i] = i; 
      this.coords[2 * i] = this.points[i].x; 
      this.coords[2 * i + 1] = this.points[i].y; 
    }
    this.sort(0, this.ids.length - 1, 0);
  }

  sort(left, right, axis) {
    if (right - left <= this.nodeSize) return;
    const median = left + Math.floor((right - left) / 2);
    this.select(left, right, median, axis);
    this.sort(left, median - 1, 1 - axis);
    this.sort(median + 1, right, 1 - axis);
  }

  select(left, right, k, axis) {
    while (right > left) {
      if (right - left > 600) { /* ... omitted for brevity ... */ }
      const t = this.coords[2 * this.ids[k] + axis];
      let i = left;
      let j = right;
      this.swap(left, k);
      if (this.coords[2 * this.ids[right] + axis] > t) this.swap(left, right);
      while (i < j) {
        this.swap(i++, j--);
        while (this.coords[2 * this.ids[i] + axis] < t) i++;
        while (this.coords[2 * this.ids[j] + axis] > t) j--;
      }
      if (this.coords[2 * this.ids[left] + axis] === t) this.swap(left, j);
      else { j++; this.swap(j, right); }
      if (j <= k) left = j + 1;
      if (k <= j) right = j - 1;
    }
  }

  swap(i, j) {
    const tmp = this.ids[i];
    this.ids[i] = this.ids[j];
    this.ids[j] = tmp;
  }

  range(minX, minY, maxX, maxY) {
    const results = [];
    for (let i = 0; i < this.ids.length; i++) {
      const id = this.ids[i]; 
      const x = this.coords[2 * id];
      const y = this.coords[2 * id + 1];
      if (x >= minX && x <= maxX && y >= minY && y <= maxY) {
        results.push(id); 
      }
    }
    return results;
  }
  finish() { /* No-op */ }
}
// --- Embedded KDBush End ---


const MapComponent = () => {
  const [isMapApiLoaded, setIsMapApiLoaded] = useState(false);
  const [isTurfLoaded, setIsTurfLoaded] = useState(false);
  const [isKDBushLoaded] = useState(true); 
  
  const [map, setMap] = useState(null);
  const [geojsonData, setGeojsonData] = useState(null);
  const [currentCoords, setCurrentCoords] = useState({ lat: initialMapCenter.lat, lng: initialMapCenter.lng });
  const [geoJsonLocationName, setGeoJsonLocationName] = useState(null);

  const [spatialIndex, setSpatialIndex] = useState(null);

  const debounceTimeoutRef = useRef(null);
  const mapRef = useRef(null); 

  const updateLocationDisplayRef = useRef();
  const debouncedUpdateLocationDisplayRef = useRef();

  // Function to load external script and poll for its global object
  const loadExternalScript = useCallback((src, id, globalVarName, setLoadedState) => {
    return new Promise((resolve) => {
      if (document.getElementById(id)) {
        console.log(`Script ${id} already exists. Checking global object.`);
        pollForGlobal(globalVarName, setLoadedState, resolve, id);
        return;
      }

      const script = document.createElement('script');
      script.src = src;
      script.id = id;
      script.async = true; 
      script.defer = true; 
      script.onload = () => {
        console.log(`Script ${id} loaded. Polling for ${globalVarName}...`);
        pollForGlobal(globalVarName, setLoadedState, resolve, id);
      };
      script.onerror = () => {
        console.error(`Error loading script: ${src}. Setting ${id} state to false.`);
        setLoadedState(false); 
        resolve(); 
      };
      document.head.appendChild(script); 
    });
  }, []);

  // Helper function to poll for a global variable
  const pollForGlobal = useCallback((globalVarName, setLoadedState, resolvePromise, scriptId, attempts = 0) => {
    const maxAttempts = 50; 
    const intervalTime = 100; 

    if (window[globalVarName]) {
      console.log(`Global object ${globalVarName} from ${scriptId} found after ${attempts * intervalTime}ms.`);
      setLoadedState(true);
      resolvePromise();
    } else if (attempts < maxAttempts) {
      setTimeout(() => {
        pollForGlobal(globalVarName, setLoadedState, resolvePromise, scriptId, attempts + 1);
      }, intervalTime);
    } else {
      console.error(`Timeout: Global object ${globalVarName} NOT FOUND from ${scriptId} after ${maxAttempts} attempts.`);
      setLoadedState(false); 
      resolvePromise(); 
    }
  }, []);

  // 1. Load Google Maps API and Turf.js scripts
  useEffect(() => {
    const googleMapsApiKey = import.meta.env.VITE_Maps_API_KEY; 

    window.initMap = () => { 
      console.log("Google Maps initMap callback fired.");
      setIsMapApiLoaded(true); 
    };

    const loadLibraries = async () => {
      console.log("Initiating loading of essential external libraries...");
      try {
        await loadExternalScript(
          `https://maps.googleapis.com/maps/api/js?key=${googleMapsApiKey}&callback=initMap`,
          'google-map-script',
          'google', 
          setIsMapApiLoaded
        );
        
        await loadExternalScript(
          'https://cdnjs.cloudflare.com/ajax/libs/Turf.js/5.1.6/turf.min.js', 
          'turf-script',
          'turf', 
          setIsTurfLoaded
        );

        console.log("External libraries loading process initiated. Check individual loaded states in logs.");

      } catch (error) {
        console.error("Failed to initiate loading of one or more external libraries:", error);
      }
    };

    loadLibraries();
  }, [loadExternalScript]); 

  // 2. Fetch GeoJSON Data from '/d_wgs84.json'
  useEffect(() => {
    fetch('/d_wgs84.json') 
      .then(response => {
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        return response.json();
      })
      .then(data => {
        setGeojsonData(data);
        console.log("GeoJSON data fetched successfully from d_wgs84.json. Number of features:", data.features ? data.features.length : 0);
      })
      .catch(error => {
        console.error("Error fetching GeoJSON from d_wgs84.json:", error);
      });
  }, []); 

  // 3. Optimized checkPointInGeoJSON 
  const checkPointInGeoJSON = useCallback((lat, lng) => {
    console.groupCollapsed(`checkPointInGeoJSON called for lat: ${lat.toFixed(6)}, lng: ${lng.toFixed(6)}`);

    if (!geojsonData || !spatialIndex || !isTurfLoaded || !isKDBushLoaded || !window.turf) {
        console.log("Dependencies NOT READY for checkPointInGeoJSON. Skipping check.");
        console.log("Current dependency states:", { geojsonData: !!geojsonData, spatialIndex: !!spatialIndex, isTurfLoaded, isKDBushLoaded, turf: !!window.turf });
        console.groupEnd();
        return null; 
    }

    const queryPoint = window.turf.point([lng, lat]); 

    let nearestFeatureName = null;
    let minDistance = Infinity; 

    const searchRadiusDegrees = MAX_DISTANCE_TO_LINE_KM / 111.32; 

    const minLng = lng - searchRadiusDegrees;
    const maxLng = lng + searchRadiusDegrees;
    const minLat = lat - searchRadiusDegrees;
    const maxLat = lat + searchRadiusDegrees;

    const potentialFeatureIndices = spatialIndex.index.range(minLng, minLat, maxLng, maxLat);
    console.log(`KDBush found ${potentialFeatureIndices.length} potential features in bounding box [${minLng.toFixed(4)}, ${minLat.toFixed(4)}, ${maxLng.toFixed(4)}, ${maxLat.toFixed(4)}].`);

    if (potentialFeatureIndices.length === 0) {
        console.log("No features found in the immediate vicinity by KDBush range search.");
        console.groupEnd();
        return null; 
    }

    for (const originalIndex of potentialFeatureIndices) {
      const feature = spatialIndex.featureMap.get(originalIndex); 
      if (!feature || !feature.geometry) {
        console.log(`Skipping invalid feature at original index ${originalIndex}.`);
        continue;
      }

      const featureName = feature.properties?.Name || feature.properties?.name || 'Unnamed Feature';
      console.log(`Evaluating feature (Original Index: ${originalIndex}): Type=${feature.geometry.type}, Name="${featureName}"`);

      if (feature.geometry.type === 'Polygon' || feature.geometry.type === 'MultiPolygon') {
        try {
            if (window.turf.booleanPointInPolygon(queryPoint, feature)) {
                nearestFeatureName = featureName;
                console.log(`Point IS INSIDE Polygon: "${nearestFeatureName}". Returning immediately.`);
                console.groupEnd();
                return nearestFeatureName; 
            }
        } catch (e) {
            console.warn(`Error in booleanPointInPolygon for feature ("${featureName}"):`, e);
        }
      } 
      else if (feature.geometry.type === 'LineString' || feature.geometry.type === 'MultiLineString') {
        try {
          const distance = window.turf.pointToLineDistance(queryPoint, feature, { units: 'kilometers' });
          console.log(`Distance to LineString ("${featureName}"): ${distance.toFixed(3)} km.`);

          if (distance < minDistance && distance <= MAX_DISTANCE_TO_LINE_KM) {
            minDistance = distance; 
            nearestFeatureName = featureName;
            console.log(`Found a closer line within range: "${nearestFeatureName}" at ${distance.toFixed(3)} km.`);
          }
        } catch (e) {
          console.warn(`Error calculating pointToLineDistance for feature ("${featureName}"):`, e);
        }
      } else {
          console.log(`Feature type "${feature.geometry.type}" not handled for proximity/containment checks.`);
      }
    }
    
    const finalResult = nearestFeatureName || null;
    console.log(`FINAL RESULT for lat: ${lat.toFixed(6)}, lng: ${lng.toFixed(6)}: Found: "${finalResult || 'None'}".`);
    console.groupEnd();
    return finalResult;
  }, [geojsonData, spatialIndex, isTurfLoaded, isKDBushLoaded, MAX_DISTANCE_TO_LINE_KM]); 

  // Function to actually update the location display based on map center
  const updateLocationDisplay = useCallback((lat, lng) => {
    const foundLocation = checkPointInGeoJSON(lat, lng);
    setGeoJsonLocationName(foundLocation);
    console.log(`Setting geoJsonLocationName state to: "${foundLocation || 'null'}"`);
  }, [checkPointInGeoJSON]); 

  // 4. Debounced function to update the location display (prevents excessive calls during map pan)
  const debouncedUpdateLocationDisplay = useCallback((lat, lng) => {
    if (debounceTimeoutRef.current) {
      clearTimeout(debounceTimeoutRef.current);
    }
    debounceTimeoutRef.current = setTimeout(() => {
      if (updateLocationDisplayRef.current) { 
         updateLocationDisplayRef.current(lat, lng); 
      }
    }, DEBOUNCE_DELAY_MS);
  }, []); 

  // Update refs whenever the actual callback functions change (ensures latest callback is used)
  useEffect(() => {
    updateLocationDisplayRef.current = updateLocationDisplay;
    debouncedUpdateLocationDisplayRef.current = debouncedUpdateLocationDisplay;
  }, [updateLocationDisplay, debouncedUpdateLocationDisplay]);


  // 5. Build Spatial Index using KDBush when geojsonData loads and Turf.js is available
  useEffect(() => {
    // Check if geojsonData, Turf.js, and KDBush are ready before building index
    // The previous error "Spatial index build skipped. Dependencies not fully met" with all 'true'
    // was likely due to the `spatialIndex` state itself not being null/undefined before the dependencies check.
    // Explicitly check for `spatialIndex === null` or `!spatialIndex`
    if (geojsonData && geojsonData.features && isKDBushLoaded && isTurfLoaded && window.turf && spatialIndex === null) {
      console.log("Attempting to build spatial index...");
      const pointsToIndex = []; 
      const featureMap = new Map(); 

      geojsonData.features.forEach((feature, index) => {
        if (feature.geometry) {
          try {
            let representativePoint = null;
            if (window.turf) { 
                if (feature.geometry.type === 'Point') {
                    representativePoint = feature.geometry.coordinates;
                } 
                else if (feature.geometry.coordinates && feature.geometry.coordinates.length > 0) {
                    try {
                        const centroid = window.turf.centroid(feature);
                        if (centroid && centroid.geometry && centroid.geometry.coordinates && 
                            Array.isArray(centroid.geometry.coordinates) && centroid.geometry.coordinates.length >= 2 &&
                            isFinite(centroid.geometry.coordinates[0]) && isFinite(centroid.geometry.coordinates[1])) {
                             representativePoint = centroid.geometry.coordinates;
                        } else {
                            // Fallback to first coordinate for lines/polygons if centroid is invalid or [0,0]
                            if ((feature.geometry.type === 'LineString' || feature.geometry.type === 'MultiLineString') && feature.geometry.coordinates[0] && feature.geometry.coordinates[0].length >= 2 &&
                                isFinite(feature.geometry.coordinates[0][0]) && isFinite(feature.geometry.coordinates[0][1])) {
                                representativePoint = feature.geometry.coordinates[0]; 
                                console.warn(`Turf.js centroid was invalid for feature (index: ${index}, name: ${feature.properties?.Name || 'Unnamed'}). Falling back to first coordinate:`, representativePoint);
                            } else if ((feature.geometry.type === 'Polygon' || feature.geometry.type === 'MultiPolygon') && feature.geometry.coordinates[0] && feature.geometry.coordinates[0][0] && feature.geometry.coordinates[0][0].length >= 2 &&
                                isFinite(feature.geometry.coordinates[0][0][0]) && isFinite(feature.geometry.coordinates[0][0][1])) {
                                representativePoint = feature.geometry.coordinates[0][0]; 
                                console.warn(`Turf.js centroid was invalid for feature (index: ${index}, name: ${feature.properties?.Name || 'Unnamed'}). Falling back to first polygon coordinate:`, representativePoint);
                            } else {
                                console.warn(`Turf.js centroid returned invalid object/coordinates for feature (index: ${index}, type: ${feature.geometry.type}, name: ${feature.properties?.Name || 'Unnamed'}) AND fallback failed - skipping indexing.`);
                                return; 
                            }
                        }
                    } catch (e) {
                        console.warn(`turf.centroid failed for feature (index: ${index}, type: ${feature.geometry.type}, name: ${feature.properties?.Name || 'Unnamed'}) - skipping indexing:`, e);
                        return; 
                    }
                } else {
                    console.warn(`Invalid or empty coordinates for feature geometry type (index: ${index}, type: ${feature.geometry.type}) - skipping centroid calculation:`, feature.geometry.coordinates);
                    return; 
                }
            } else {
                console.warn("Turf.js not available for centroid calculation during spatial index build.");
                return; 
            }
            
            // Final validation of representativePoint before adding to index
            if (representativePoint && Array.isArray(representativePoint) && representativePoint.length >= 2 && 
                isFinite(representativePoint[0]) && isFinite(representativePoint[1])) {
              pointsToIndex.push({
                x: representativePoint[0], // Longitude
                y: representativePoint[1], // Latitude
                featureIndex: index 
              });
              featureMap.set(index, feature); 
            } else {
              console.warn(`Skipping feature (index: ${index}, name: ${feature.properties?.Name || 'Unnamed'}) due to invalid final representative point (NaN/Infinity or malformed after checks):`, representativePoint);
            }
          } catch (e) {
            console.error(`Critical Error processing feature (index: ${index}, name: ${feature.properties?.Name || 'Unnamed'}) for indexing:`, feature, e);
          }
        } else {
          console.warn(`Skipping feature (index: ${index}) with no geometry.`);
        }
      });

      if (pointsToIndex.length > 0) {
        const index = new KDBush(pointsToIndex); 
        index.finish(); 

        setSpatialIndex({ index, featureMap });
        console.log(`Spatial index built successfully with ${pointsToIndex.length} points.`);
        console.log("Sample of indexed points (first 5):", pointsToIndex.slice(0, 5)); 
        console.log("Sample of featureMap values (first 5 names):", Array.from(featureMap.values()).slice(0, 5).map(f => f.properties?.Name || f.properties?.name));
      } else {
        console.warn("No valid points found to build spatial index. Spatial index will be null. Check GeoJSON data and centroid calculation logic.");
        setSpatialIndex(null); 
      }
    } else {
        console.log("Spatial index build skipped. Dependencies NOT YET fully met OR spatialIndex is already built:", { geojsonData: !!geojsonData, isKDBushLoaded, isTurfLoaded, turf: !!window.turf, spatialIndex: !!spatialIndex });
    }
  }, [geojsonData, isTurfLoaded, isKDBushLoaded, spatialIndex]); // Add spatialIndex to dependencies

  // 6. Initialize Google Map and attach event listeners
  useEffect(() => {
    if (isMapApiLoaded && mapRef.current && !map && window.google) {
      console.log("MapRef current value (for map init):", mapRef.current); 
      console.log("Initializing Google Map instance...");

      const mapOptions = {
        center: initialMapCenter,
        zoom: 7, 
        streetViewControl: false,
        mapTypeControl: false,
        fullscreenControl: false,
        zoomControl: true,
        clickableIcons: false, 
      };

      const googleMapInstance = new window.google.maps.Map(mapRef.current, mapOptions);
      setMap(googleMapInstance); 

      const currentMapCenter = googleMapInstance.getCenter();
      if (currentMapCenter) {
        const lat = currentMapCenter.lat();
        const lng = currentMapCenter.lng();
        setCurrentCoords({ lat, lng });
        if (updateLocationDisplayRef.current) {
          updateLocationDisplayRef.current(lat, lng); 
        } else {
          console.warn("updateLocationDisplayRef not ready during initial map center update. Delaying initial check.");
          setTimeout(() => updateLocationDisplayRef.current && updateLocationDisplayRef.current(lat, lng), 500);
        }
      }

      const centerChangedListener = googleMapInstance.addListener('center_changed', () => {
        const center = googleMapInstance.getCenter();
        if (center) {
          const lat = center.lat();
          const lng = center.lng();
          setCurrentCoords({ lat, lng });
          if (debouncedUpdateLocationDisplayRef.current) {
            debouncedUpdateLocationDisplayRef.current(lat, lng); 
          } else {
            console.warn("debouncedUpdateLocationDisplayRef not ready during map center change.");
          }
        }
      });

      return () => {
        if (centerChangedListener) {
          window.google.maps.event.removeListener(centerChangedListener);
        }
        if (debounceTimeoutRef.current) {
          clearTimeout(debounceTimeoutRef.current);
        }
        setMap(null); 
      };
    } else {
        console.log("Map initialization skipped. Current states:", { isMapApiLoaded, mapRefCurrent: !!mapRef.current, map: !!map, google: !!window.google });
    }
  }, [isMapApiLoaded, mapRef.current]); 

  // 7. Add and style GeoJSON data on the map once map, geojsonData, and Turf.js are ready
  useEffect(() => {
    if (map && geojsonData && isTurfLoaded && window.turf) { 
      console.log("Adding and styling GeoJSON data on map...");
      map.data.forEach(feature => map.data.remove(feature));
      map.data.addGeoJson(geojsonData);

      map.data.setStyle(feature => {
        if (feature.getGeometry().getType() === 'LineString' || feature.getGeometry().getType() === 'MultiLineString') {
          return {
            strokeColor: '#0070ff', 
            strokeWeight: 4,        
            strokeOpacity: 0.8      
          };
        } else if (feature.getGeometry().getType() === 'Polygon' || feature.getGeometry().getType() === 'MultiPolygon') {
          return {
            strokeColor: '#0000FF', 
            strokeWeight: 2,
            fillColor: '#0000FF',   
            fillOpacity: 0.5        
          };
        }
        return {}; 
      });

      const bounds = new window.google.maps.LatLngBounds();
      let hasValidCoordsInFeatures = false; 

      geojsonData.features.forEach(feature => {
        if (feature.geometry && feature.geometry.coordinates) {
          try {
            const bbox = window.turf.bbox(feature);
            if (bbox && bbox.length === 4 && bbox.every(coord => typeof coord === 'number' && isFinite(coord))) { 
              bounds.extend(new window.google.maps.LatLng(bbox[1], bbox[0])); 
              bounds.extend(new window.google.maps.LatLng(bbox[3], bbox[2])); 
              hasValidCoordsInFeatures = true;
            } else {
                 console.warn("Invalid bbox calculated for feature (non-finite or malformed coordinates), skipping bounds extension:", feature, bbox);
            }
          } catch (e) {
            console.warn("Could not calculate bbox for feature (likely invalid geometry structure for turf.bbox), skipping bounds extension:", feature, e);
          }
        }
      });

      if (hasValidCoordsInFeatures && !bounds.isEmpty()) {
        map.fitBounds(bounds);
        map.setZoom(Math.min(map.getZoom(), 15)); 
        console.log("Map fitted to GeoJSON bounds.");
      } else {
        console.warn("No valid GeoJSON coordinates found to fit bounds, defaulting to initial map center.");
        map.setCenter(initialMapCenter);
        map.setZoom(7);
      }
    } else {
        console.log("Map data addition/styling skipped. Dependencies not fully met:", { map: !!map, geojsonData: !!geojsonData, isTurfLoaded, turf: !!window.turf });
    }
  }, [map, geojsonData, isTurfLoaded]); 

  // Function to copy current coordinates to clipboard
  const copyCoordinates = () => {
    const coordText = `Latitude = ${currentCoords.lat.toFixed(8)} Longitude = ${currentCoords.lng.toFixed(8)}`;
    const el = document.createElement('textarea');
    el.value = coordText;
    document.body.appendChild(el); 
    el.select();
    document.execCommand('copy'); 
    document.body.removeChild(el); 
    console.log("Coordinates copied!");
  };

  // Function to reset the map to its initial center and zoom level
  const resetToCenter = () => {
    if (map) {
      map.setCenter(initialMapCenter); 
      map.setZoom(7); 
      setCurrentCoords(initialMapCenter); 
      updateLocationDisplayRef.current(initialMapCenter.lat, initialMapCenter.lng);
    }
  };

  // Placeholder for map export functionality
  const exportMap = () => {
    console.log('Export map functionality placeholder');
  };

  return (
    <div className="relative w-full h-full overflow-hidden font-sans bg-gray-100">
      {isMapApiLoaded && isTurfLoaded && isKDBushLoaded ? ( 
        <>
          {/* Map container div */}
          <div 
            ref={mapRef}
            id="map-container"
            style={{ width: '100%', height: '800px' }}
            className="absolute inset-0 rounded-lg shadow-xl"
          ></div>

          {/* Fixed Cursor Icon in the center of the screen */}
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-10 flex items-center justify-center pointer-events-none">
            <svg
                width="40"
                height="40"
                viewBox="0 0 24 24"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                className="drop-shadow-lg"
            >
                <path
                    d="M12 2L2 22h20L12 2z"
                    fill="red"
                    stroke="white"
                    strokeWidth="1.5"
                />
                <circle cx="12" cy="5" r="2.5" fill="red" stroke="white" strokeWidth="1"/>
            </svg>
          </div>

          {/* Coordinate Display - Bottom Left */}
          <div className="absolute bottom-4 left-4 bg-black bg-opacity-80 text-white px-4 py-2 rounded-lg text-sm font-mono z-20 shadow-md">
            Latitude = {currentCoords.lat.toFixed(8)} Longitude = {currentCoords.lng.toFixed(8)}
          </div>

          {/* Location Info - Bottom Left (above coordinates) */}
          <div className="absolute bottom-16 left-4 bg-red-600 text-white px-3 py-1 rounded-lg text-sm flex items-center gap-2 z-20 shadow-md">
            <MapPin size={16} />
            {geoJsonLocationName 
              ? geoJsonLocationName
              : 'Unknown Location'
            }
          </div>

          {/* Control Buttons - Bottom Right */}
          <div className="absolute bottom-4 right-4 flex gap-2 z-20">
            <button
              onClick={copyCoordinates}
              className="bg-blue-600 hover:bg-blue-700 text-white p-3 rounded-full shadow-lg transition-colors duration-200 ease-in-out transform hover:scale-105 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-opacity-75"
              title="Copy Coordinates"
            >
              <Copy size={20} />
            </button>
            
            <button
              onClick={exportMap}
              className="bg-red-600 hover:bg-red-700 text-white p-3 rounded-full shadow-lg transition-colors duration-200 ease-in-out transform hover:scale-105 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-opacity-75"
              title="Export Map"
            >
              <Download size={20} />
            </button>
          </div>

          {/* Home Button - Top Right */}
          <div className="absolute top-4 right-4 z-20">
            <button
              onClick={resetToCenter}
              className="bg-green-600 hover:bg-green-700 text-white p-3 rounded-full shadow-lg transition-colors duration-200 ease-in-out transform hover:scale-105 focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-opacity-75"
              title="Reset to Center"
            >
              <Home size={20} />
            </button>
          </div>
        </>
      ) : (
        <div className="flex items-center justify-center h-full min-h-[500px]">
          <div className="text-lg text-gray-700">Loading Map...</div>
        </div>
      )}
    </div>
  );
};

export default React.memo(MapComponent);
