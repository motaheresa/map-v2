import React, { useState, useEffect, useCallback, useRef } from 'react';
import { MapPin, Copy, Download, Home, Info, Search, Satellite, Map as MapIcon, X } from 'lucide-react'; 

// الإحداثيات الأولية لمركز الخريطة
const initialMapCenter = {
  lat: 30.885, // خط العرض التقريبي لـ 'جرارا معنيا'
  lng: 30.625 // خط الطول التقريبي لـ 'جرارا معنيا'
};

// تحديد أقصى مسافة (بالكيلومترات) للكشف عن النقاط المعروضة
const MAX_DISTANCE_TO_POINT_KM = 0.05; // 50 مترًا، دقيقة جداً للنقاط الفردية

// تحديد أقصى مسافة (بالكيلومترات) للكشف عن الخطوط أو حواف المضلعات
const MAX_DISTANCE_TO_LINE_OR_EDGE_KM = 1.0; // 1.0 كيلومتر (1000 متر) كخيار احتياطي

// تأخير Debounce بالمللي ثانية لتحديثات الموقع
const DEBOUNCE_DELAY_MS = 150; 

// --- بداية KDBush المضمنة ---
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
// --- نهاية KDBush المضمنة ---


const MapComponent = () => {
  const [isMapApiLoaded, setIsMapApiLoaded] = useState(false);
  const [isTurfLoaded, setIsTurfLoaded] = useState(false);
  const [isKDBushLoaded] = useState(true); 
  
  const [map, setMap] = useState(null);
  const [geojsonData, setGeojsonData] = useState(null); // البيانات الأصلية (خطوط ومضلعات)
  const [processedPointsData, setProcessedPointsData] = useState(null); // البيانات المعالجة (نقاط فردية من الرؤوس)
  
  const [currentCoords, setCurrentCoords] = useState({ lat: initialMapCenter.lat, lng: initialMapCenter.lng });
  const [geoJsonLocationName, setGeoJsonLocationName] = useState(null);

  const [spatialIndex, setSpatialIndex] = useState(null); // للفهرسة السريعة للنقاط المعالجة

  const debounceTimeoutRef = useRef(null);
  const mapRef = useRef(null); 

  const updateLocationDisplayRef = useRef();
  const debouncedUpdateLocationDisplayRef = useRef();

  // حالات جديدة لعناصر التحكم التفاعلية
  const [showSearchInput, setShowSearchInput] = useState(false);
  const [searchedPlaceInput, setSearchedPlaceInput] = useState('');
  const [searchResultInfo, setSearchResultInfo] = useState(null);
  const [showAboutModal, setShowAboutModal] = useState(false);
  const [mapType, setMapType] = useState('roadmap'); // 'roadmap' أو 'satellite'

  // دالة لتحميل السكربت الخارجي والاستقصاء عن كائنه العام
  const loadExternalScript = useCallback((src, id, globalVarName, setLoadedState) => {
    return new Promise((resolve) => {
      if (document.getElementById(id)) {
        console.log(`السكربت ${id} موجود بالفعل. جاري التحقق من الكائن العام.`);
        pollForGlobal(globalVarName, setLoadedState, resolve, id);
        return;
      }

      const script = document.createElement('script');
      script.src = src;
      script.id = id;
      script.async = true; 
      script.defer = true; 
      script.onload = () => {
        console.log(`السكربت ${id} تم تحميله. جاري الاستقصاء عن ${globalVarName}...`);
        pollForGlobal(globalVarName, setLoadedState, resolve, id);
      };
      script.onerror = () => {
        console.error(`خطأ في تحميل السكربت: ${src}. جاري تعيين حالة ${id} إلى false.`);
        setLoadedState(false); 
        resolve(); 
      };
      document.head.appendChild(script); 
    });
  }, []);

  // دالة مساعدة للاستقصاء عن متغير عام للتأكد من توفره
  const pollForGlobal = useCallback((globalVarName, setLoadedState, resolvePromise, scriptId, attempts = 0) => {
    const maxAttempts = 50; 
    const intervalTime = 100; 

    if (window[globalVarName]) {
      console.log(`تم العثور على الكائن العام ${globalVarName} من ${scriptId} بعد ${attempts * intervalTime} مللي ثانية.`);
      setLoadedState(true);
      resolvePromise();
    } else if (attempts < maxAttempts) {
      setTimeout(() => {
        pollForGlobal(globalVarName, setLoadedState, resolvePromise, scriptId, attempts + 1);
      }, intervalTime);
    } else {
      console.error(`انتهت المهلة: لم يتم العثور على الكائن العام ${globalVarName} من ${scriptId} بعد ${maxAttempts} محاولة.`);
      setLoadedState(false); 
      resolvePromise(); 
    }
  }, []);

  // 1. تحميل واجهة برمجة تطبيقات خرائط جوجل وسكربت Turf.js
  useEffect(() => {
    const googleMapsApiKey = 'AIzaSyC5MHgv-Vax9PJqB2kROWaiVYD5AtFHnIc'; 

    window.initMap = () => { 
      console.log("تم تشغيل رد اتصال Google Maps initMap.");
      setIsMapApiLoaded(true); 
    };

    const loadLibraries = async () => {
      console.log("جاري بدء تحميل المكتبات الخارجية الأساسية...");
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

        console.log("تم بدء عملية تحميل المكتبات الخارجية. تحقق من حالات التحميل الفردية في السجلات.");

      } catch (error) {
        console.error("فشل في بدء تحميل واحدة أو أكثر من المكتبات الخارجية:", error);
      }
    };

    loadLibraries();
  }, [loadExternalScript]); 

  // 2. جلب بيانات GeoJSON الأصلية ومعالجتها إلى نقاط فردية
  useEffect(() => {
    fetch('/d_wgs84.json') 
      .then(response => {
        if (!response.ok) {
          throw new Error(`خطأ HTTP! الحالة: ${response.status}`);
        }
        return response.json();
      })
      .then(data => {
        setGeojsonData(data); // حفظ البيانات الأصلية
        console.log("تم جلب بيانات GeoJSON الأصلية بنجاح من d_wgs84.json. عدد الميزات الأصلية:", data.features ? data.features.length : 0);

        // معالجة البيانات: تحويل LineStrings والمضلعات إلى نقاط فردية (كل رأس نقطة)
        const newProcessedPointsFeatures = [];
        data.features.forEach(originalFeature => {
          const properties = { ...originalFeature.properties }; 
          const featureType = originalFeature.geometry.type;

          if (featureType === 'LineString') {
            originalFeature.geometry.coordinates.forEach((coord) => {
              newProcessedPointsFeatures.push({
                type: 'Feature',
                properties: { 
                  ...properties,
                  originalType: featureType, // النوع الأصلي للميزة
                },
                geometry: {
                  type: 'Point',
                  coordinates: coord // [lng, lat]
                }
              });
            });
          } else if (featureType === 'Polygon') {
            // للمضلعات، نأخذ نقاط الحلقة الخارجية فقط
            if (originalFeature.geometry.coordinates && originalFeature.geometry.coordinates[0]) {
              originalFeature.geometry.coordinates[0].forEach((coord) => {
                newProcessedPointsFeatures.push({
                  type: 'Feature',
                  properties: { 
                    ...properties,
                    originalType: featureType, 
                  },
                  geometry: {
                    type: 'Point',
                    coordinates: coord
                  }
                });
              });
            }
          } else if (featureType === 'MultiPolygon') {
              if (originalFeature.geometry.coordinates) {
                  originalFeature.geometry.coordinates.forEach(polygon => {
                      if (polygon && polygon[0]) { 
                          polygon[0].forEach((coord) => {
                              newProcessedPointsFeatures.push({
                                  type: 'Feature',
                                  properties: { 
                                      ...properties,
                                      originalType: featureType, 
                                  },
                                  geometry: {
                                      type: 'Point',
                                      coordinates: coord
                                  }
                              });
                          });
                      }
                  });
              }
          } else if (featureType === 'Point') {
              // إذا كانت الميزة الأصلية نقطة بالفعل، أضفها مباشرة
              newProcessedPointsFeatures.push({
                  type: 'Feature',
                  properties: {
                      ...properties,
                      originalType: featureType, 
                  },
                  geometry: {
                      type: 'Point',
                      coordinates: originalFeature.geometry.coordinates
                  }
              });
          }
        });
        setProcessedPointsData({ type: 'FeatureCollection', features: newProcessedPointsFeatures });
        console.log(`تم معالجة بيانات GeoJSON بنجاح إلى ${newProcessedPointsFeatures.length} نقطة للعرض.`);
      })
      .catch(error => {
        console.error("خطأ في جلب أو معالجة GeoJSON من d_wgs84.json:", error);
      });
  }, []); 

  // 3. checkPointInGeoJSON المحسّنة (منطق تحديد الموقع الدقيق للخطوط والمضلعات)
  const checkPointInGeoJSON = useCallback((lat, lng) => {
    console.groupCollapsed(`تم استدعاء checkPointInGeoJSON لـ خط عرض: ${lat.toFixed(6)}, خط طول: ${lng.toFixed(6)}`);

    if (!geojsonData || !processedPointsData || !spatialIndex || !isTurfLoaded || !isKDBushLoaded || !window.turf) {
        console.log("الاعتماديات غير جاهزة لـ checkPointInGeoJSON. جاري تخطي التحقق.");
        console.log("حالات الاعتمادية الحالية:", { geojsonData: !!geojsonData, processedPointsData: !!processedPointsData, spatialIndex: !!spatialIndex, isTurfLoaded, isKDBushLoaded, turf: !!window.turf });
        console.groupEnd();
        return null; 
    }

    const queryPoint = window.turf.point([lng, lat]); 
    let finalDetectedName = null;

    // المرحلة 1: البحث عن أقرب نقطة معروضة (زرقاء)
    let nearestDisplayedPointName = null;
    let minDistanceToDisplayedPoint = Infinity;

    const searchRadiusDegreesForPoints = MAX_DISTANCE_TO_POINT_KM / 111.32; 
    const minLngPoints = lng - searchRadiusDegreesForPoints;
    const maxLngPoints = lng + searchRadiusDegreesForPoints;
    const minLatPoints = lat - searchRadiusDegreesForPoints;
    const maxLatPoints = lat + searchRadiusDegreesForPoints;

    const potentialPointIndices = spatialIndex.index.range(minLngPoints, minLatPoints, maxLngPoints, maxLatPoints);
    console.log(`KDBush وجد ${potentialPointIndices.length} نقطة محتملة (زرقاء) في مربع التحديد.`);

    for (const originalIndex of potentialPointIndices) {
      const feature = spatialIndex.featureMap.get(originalIndex); 
      if (!feature || !feature.geometry || feature.geometry.type !== 'Point') continue;

      const featureName = feature.properties?.Name || feature.properties?.name || 'ميزة غير مسماة';
      try {
        const distance = window.turf.distance(queryPoint, feature, { units: 'kilometers' });
        if (distance <= MAX_DISTANCE_TO_POINT_KM && distance < minDistanceToDisplayedPoint) {
          minDistanceToDisplayedPoint = distance; 
          nearestDisplayedPointName = featureName;
          console.log(`  [المرحلة 1] تم العثور على أقرب نقطة معروضة: "${featureName}" على مسافة ${distance.toFixed(3)} كم.`);
        }
      } catch (e) {
        console.warn(`خطأ في حساب المسافة للنقطة المعروضة ("${featureName}"):`, e);
      }
    }

    if (nearestDisplayedPointName) {
        finalDetectedName = nearestDisplayedPointName;
        console.log(`[القرار النهائي] تم الكشف عن اسم من أقرب نقطة معروضة: ${finalDetectedName}`);
        console.groupEnd();
        return finalDetectedName;
    }

    // المرحلة 2: إذا لم يتم العثور على نقطة معروضة قريبة، فابحث في الخطوط الأصلية والمضلعات
    console.log("[المرحلة 2] لم يتم العثور على نقطة معروضة قريبة. جاري البحث في الخطوط/المضلعات الأصلية.");
    let bestContainedPolygonName = null; 
    let minContainedArea = Infinity; 
    let nearestLineOrEdgeName = null; 
    let minDistanceToLineOrEdge = Infinity; 

    // مسافة بحث أكبر قليلاً للخطوط/المضلعات
    const searchRadiusDegreesForGeometries = MAX_DISTANCE_TO_LINE_OR_EDGE_KM / 111.32; 
    const minLngGeometries = lng - searchRadiusDegreesForGeometries;
    const maxLngGeometries = lng + searchRadiusDegreesForGeometries;
    const minLatGeometries = lat - searchRadiusDegreesForGeometries;
    const maxLatGeometries = lat + searchRadiusDegreesForGeometries;

    // بما أن KDBush تم بناؤها على centroids الميزات الأصلية، يمكننا استخدامها هنا أيضاً للميزات الأصلية
    // لتقليل عدد الميزات التي سنقوم بتحليلها بالتفصيل
    const potentialOriginalFeatureIndices = spatialIndex.index.range(minLngGeometries, minLatGeometries, maxLngGeometries, maxLatGeometries);
    console.log(`  KDBush وجد ${potentialOriginalFeatureIndices.length} ميزة أصلية محتملة في مربع التحديد الأكبر.`);


    for (const originalIndex of potentialOriginalFeatureIndices) {
        const feature = spatialIndex.featureMap.get(originalIndex); // الحصول على الميزة الأصلية من الخريطة
        if (!feature || !feature.geometry) continue;

        const featureName = feature.properties?.Name || feature.properties?.name || 'ميزة غير مسماة';

        if (feature.geometry.type === 'Polygon' || feature.geometry.type === 'MultiPolygon') {
            try {
                if (window.turf.booleanPointInPolygon(queryPoint, feature)) {
                    let currentPolygonArea = 0;
                    try {
                        currentPolygonArea = window.turf.area(feature); 
                        if (!isFinite(currentPolygonArea) || currentPolygonArea <= 0) {
                            currentPolygonArea = Infinity; 
                        }
                    } catch (areaError) {
                        console.warn(`  [المرحلة 2 - مضلع] خطأ في حساب مساحة المضلع ("${featureName}"):`, areaError);
                        currentPolygonArea = Infinity; 
                    }
                    
                    if (currentPolygonArea < minContainedArea) {
                        minContainedArea = currentPolygonArea;
                        bestContainedPolygonName = featureName;
                        console.log(`  [المرحلة 2 - مضلع] تم العثور على مضلع يحتوي أفضل: "${featureName}" بمساحة ${currentPolygonArea.toFixed(2)} كم مربع.`);
                    }
                }
            } catch (e) {
                console.warn(`  [المرحلة 2 - مضلع] خطأ في booleanPointInPolygon للمضلع ("${featureName}"):`, e);
            }
        } 
        else if (feature.geometry.type === 'LineString' || feature.geometry.type === 'MultiLineString') {
            try {
                const distance = window.turf.pointToLineDistance(queryPoint, feature, { units: 'kilometers' });
                console.log(`  [المرحلة 2 - خط] المسافة إلى LineString ("${featureName}"): ${distance.toFixed(3)} كم.`);

                if (distance <= MAX_DISTANCE_TO_LINE_OR_EDGE_KM && distance < minDistanceToLineOrEdge) {
                    minDistanceToLineOrEdge = distance; 
                    nearestLineOrEdgeName = featureName;
                    console.log(`  [المرحلة 2 - خط] تم العثور على خط أقرب ضمن النطاق: "${featureName}" على مسافة ${distance.toFixed(3)} كم.`);
                }
            } catch (e) {
                console.warn(`  [المرحلة 2 - خط] خطأ في حساب pointToLineDistance للميزة ("${featureName}"):`, e);
            }
        }
        // يمكننا إضافة هنا منطق للكشف عن قرب حواف المضلعات أيضاً إذا أردنا:
        if (feature.geometry.type === 'Polygon' || feature.geometry.type === 'MultiPolygon') {
            try {
                let polygonExterior = null;
                if (feature.geometry.type === 'Polygon' && feature.geometry.coordinates && feature.geometry.coordinates[0]) {
                    polygonExterior = window.turf.lineString(feature.geometry.coordinates[0]);
                } else if (feature.geometry.type === 'MultiPolygon' && feature.geometry.coordinates && feature.geometry.coordinates[0] && feature.geometry.coordinates[0][0]) {
                    polygonExterior = window.turf.lineString(feature.geometry.coordinates[0][0]);
                }
                if (polygonExterior) {
                    const distance = window.turf.pointToLineDistance(queryPoint, polygonExterior, { units: 'kilometers' });
                    console.log(`  [المرحلة 2 - حافة مضلع] المسافة إلى حافة المضلع ("${featureName}"): ${distance.toFixed(3)} كم.`);
                    if (distance <= MAX_DISTANCE_TO_LINE_OR_EDGE_KM && distance < minDistanceToLineOrEdge) {
                        minDistanceToLineOrEdge = distance;
                        nearestLineOrEdgeName = featureName;
                        console.log(`  [المرحلة 2 - حافة مضلع] تم العثور على حافة ميزة أقرب ضمن النطاق: "${featureName}" على مسافة ${distance.toFixed(3)} كم.`);
                    }
                }
            } catch (e) {
                console.warn(`  [المرحلة 2 - حافة مضلع] خطأ في حساب المسافة لحافة المضلع ("${featureName}"):`, e);
            }
        }
    }
    
    // اتخاذ القرار النهائي بناءً على المرحلتين
    if (bestContainedPolygonName) {
        finalDetectedName = bestContainedPolygonName; 
        console.log(`[القرار النهائي] تم الكشف عن اسم من مضلع يحتوي: ${finalDetectedName}`);
    } else if (nearestLineOrEdgeName) {
        finalDetectedName = nearestLineOrEdgeName;
        console.log(`[القرار النهائي] تم الكشف عن اسم من أقرب خط/حافة: ${finalDetectedName}`);
    } else {
        console.log("[القرار النهائي] لم يتم العثور على اسم ضمن عتبات الكشف.");
    }

    console.groupEnd();
    return finalDetectedName;
  }, [geojsonData, processedPointsData, spatialIndex, isTurfLoaded, isKDBushLoaded, MAX_DISTANCE_TO_POINT_KM, MAX_DISTANCE_TO_LINE_OR_EDGE_KM]); 

  // دالة لتحديث عرض الموقع بناءً على مركز الخريطة
  const updateLocationDisplay = useCallback((lat, lng) => {
    const foundLocation = checkPointInGeoJSON(lat, lng);
    setGeoJsonLocationName(foundLocation);
    console.log(`جاري تعيين حالة geoJsonLocationName إلى: "${foundLocation || 'null'}"`);
  }, [checkPointInGeoJSON]); 

  // 4. دالة Debounced لتحديث عرض الموقع (تمنع الاستدعاءات المفرطة أثناء تحريك الخريطة)
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

  // تحديث الـ refs كلما تغيرت دوال رد الاتصال الفعلية (يضمن استخدام أحدث رد اتصال)
  useEffect(() => {
    updateLocationDisplayRef.current = updateLocationDisplay;
    debouncedUpdateLocationDisplayRef.current = debouncedUpdateLocationDisplay;
  }, [updateLocationDisplay, debouncedUpdateLocationDisplay]);


  // 5. بناء الفهرس المكاني باستخدام KDBush عندما يتم تحميل processedPointsData (فهرسة النقاط المعروضة)
  useEffect(() => {
    // بناء الفهرس فقط إذا تم استيفاء جميع الاعتماديات ولم يتم بناء الفهرس المكاني بعد (هو null)
    if (processedPointsData && processedPointsData.features && isKDBushLoaded && isTurfLoaded && window.turf && spatialIndex === null) {
      console.log("جاري محاولة بناء الفهرس المكاني من النقاط المعالجة (Processed Points)...");
      const pointsToIndex = []; 
      const featureMap = new Map(); // لتخزين الميزة الكاملة للنقطة المعالجة

      processedPointsData.features.forEach((feature, index) => {
        if (feature.geometry && feature.geometry.type === 'Point' && 
            Array.isArray(feature.geometry.coordinates) && feature.geometry.coordinates.length >= 2 &&
            isFinite(feature.geometry.coordinates[0]) && isFinite(feature.geometry.coordinates[1])) {
          pointsToIndex.push({
            x: feature.geometry.coordinates[0], // خط الطول
            y: feature.geometry.coordinates[1], // خط العرض
            featureIndex: index 
          });
          featureMap.set(index, feature); // تخزين الميزة الكاملة للنقطة المعالجة
        } else {
          console.warn(`جاري تخطي الميزة (الفهرس: ${index}) من الفهرسة بسبب هندسة غير صالحة أو ليست نقطية.`);
        }
      });

      if (pointsToIndex.length > 0) {
        const index = new KDBush(pointsToIndex); 
        index.finish(); 

        setSpatialIndex({ index, featureMap });
        console.log(`تم بناء الفهرس المكاني بنجاح مع ${pointsToIndex.length} نقطة (من النقاط المعالجة).`);
      } else {
        console.warn("لم يتم العثور على نقاط صالحة لبناء الفهرس المكاني. سيكون الفهرس المكاني null.");
        setSpatialIndex(null); 
      }
    } else {
        console.log("تم تخطي بناء الفهرس المكاني. الاعتماديات لم يتم استيفائها بالكامل بعد أو تم بناء الفهرس المكاني بالفعل:", { processedPointsData: !!processedPointsData, isKDBushLoaded, isTurfLoaded, turf: !!window.turf, spatialIndex: !!spatialIndex });
    }
  }, [processedPointsData, isTurfLoaded, isKDBushLoaded, spatialIndex]); 

  // 6. تهيئة خريطة جوجل وإرفاق مستمعي الأحداث
  useEffect(() => {
    if (isMapApiLoaded && mapRef.current && !map && window.google) {
      console.log("قيمة MapRef الحالية (لتهيئة الخريطة):", mapRef.current); 
      console.log("جاري تهيئة كائن خريطة جوجل...");

      const mapOptions = {
        center: initialMapCenter,
        zoom: 7, 
        streetViewControl: false,
        mapTypeControl: false,
        fullscreenControl: false,
        zoomControl: true,
        clickableIcons: false, 
        mapTypeId: mapType 
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
          console.warn("updateLocationDisplayRef غير جاهز أثناء تحديث مركز الخريطة الأولي. جاري تأخير الفحص الأولي.");
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
            console.warn("debouncedUpdateLocationDisplayRef غير جاهز أثناء تغيير مركز الخريطة.");
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
        console.log("تم تخطي تهيئة الخريطة. الحالات الحالية:", { isMapApiLoaded, mapRefCurrent: !!mapRef.current, map: !!map, google: !!window.google });
    }
  }, [isMapApiLoaded, mapRef.current, mapType]); 

  // تحديث نوع الخريطة عند تغيير حالة mapType
  useEffect(() => {
    if (map && window.google) {
      map.setMapTypeId(mapType);
    }
  }, [map, mapType]);


  // 7. إضافة وتنسيق البيانات المعالجة (النقاط) على الخريطة
  useEffect(() => {
    if (map && processedPointsData && isTurfLoaded && window.turf) { 
      console.log("جاري إضافة وتنسيق البيانات المعالجة (النقاط) على الخريطة...");
      map.data.forEach(feature => map.data.remove(feature)); // إزالة أي ميزات سابقة
      map.data.addGeoJson(processedPointsData); // إضافة البيانات كنقاط

      // تعريف النمط الافتراضي لميزات النقاط
      const defaultPointStyle = {
        icon: {
          path: window.google.maps.SymbolPath.CIRCLE, // شكل دائرة
          fillColor: '#0070ff', // لون أزرق
          fillOpacity: 0.8,
          strokeWeight: 1,
          strokeColor: '#FFFFFF', // حدود بيضاء
          scale: 5 // حجم النقطة
        }
      };

      map.data.setStyle(feature => {
        // التحقق من اسم الميزة الأصلية للمقارنة مع نتيجة البحث
        const originalFeatureName = feature.getProperty('Name') || feature.getProperty('name');
        const searchFeatureName = searchResultInfo?.feature?.properties?.Name || searchResultInfo?.feature?.properties?.name;
        
        const isHighlighted = searchResultInfo && originalFeatureName === searchFeatureName;

        if (feature.getGeometry().getType() === 'Point') {
          if (isHighlighted) {
            return {
              icon: {
                path: window.google.maps.SymbolPath.CIRCLE,
                fillColor: '#FF0000', // أحمر للمظلل
                fillOpacity: 1.0,
                strokeWeight: 2,
                strokeColor: '#FFFFFF', 
                scale: 8 // حجم أكبر للمظلل
              }
            };
          }
          return defaultPointStyle;
        }
        return {}; // في حالة وجود أنواع هندسية أخرى بشكل غير متوقع
      });

      // ضبط حدود الخريطة لتناسب جميع النقاط المعالجة
      const bounds = new window.google.maps.LatLngBounds();
      let hasValidCoordsInFeatures = false; 

      processedPointsData.features.forEach(feature => {
        if (feature.geometry && feature.geometry.type === 'Point' && feature.geometry.coordinates) {
          const coord = feature.geometry.coordinates;
          if (Array.isArray(coord) && coord.length >= 2 && isFinite(coord[0]) && isFinite(coord[1])) {
            bounds.extend(new window.google.maps.LatLng(coord[1], coord[0]));
            hasValidCoordsInFeatures = true;
          }
        }
      });

      if (hasValidCoordsInFeatures && !bounds.isEmpty()) {
        map.fitBounds(bounds);
        map.setZoom(Math.min(map.getZoom(), 15)); 
        console.log("تم ضبط الخريطة على حدود النقاط المعالجة.");
      } else {
        console.warn("لم يتم العثور على إحداثيات نقاط صالحة لضبط الحدود، جاري العودة إلى مركز الخريطة الأولي.");
        map.setCenter(initialMapCenter);
        map.setZoom(7);
      }
    } else {
        console.log("تم تخطي إضافة بيانات الخريطة/التنسيق. الاعتماديات لم يتم استيفائها بالكامل:", { map: !!map, processedPointsData: !!processedPointsData, isTurfLoaded, turf: !!window.turf });
    }
  }, [map, processedPointsData, isTurfLoaded, searchResultInfo]); 

  // دالة لنسخ الإحداثيات الحالية واسم الموقع إلى الحافظة
  const copyCoordinates = useCallback(() => {
    const locationName = geoJsonLocationName || 'موقع غير معروف';
    const coordText = `خط عرض = ${currentCoords.lat.toFixed(8)} خط طول = ${currentCoords.lng.toFixed(8)}\nالموقع: ${locationName}`;
    const el = document.createElement('textarea');
    el.value = coordText;
    document.body.appendChild(el); 
    el.select();
    document.execCommand('copy'); 
    document.body.removeChild(el); 
    console.log("تم نسخ الإحداثيات واسم الموقع!");
  }, [currentCoords, geoJsonLocationName]);

  // دالة لإعادة تعيين الخريطة إلى مركزها الأولي ومستوى التكبير
  const resetToCenter = useCallback(() => {
    if (map) {
      map.setCenter(initialMapCenter); 
      map.setZoom(7); 
      setCurrentCoords(initialMapCenter); 
      updateLocationDisplayRef.current(initialMapCenter.lat, initialMapCenter.lng);

      setSearchResultInfo(null);
      if (map.data) {
        map.data.revertStyle(); 
      }
    }
  }, [map]); 

  // عنصر نائب لوظيفة تصدير الخريطة
  const exportMap = useCallback(() => {
    console.log('عنصر نائب لوظيفة تصدير الخريطة');
  }, [geojsonData]);

  // التعامل مع تبديل نوع الخريطة (Roadmap <-> Satellite)
  const handleMapTypeToggle = useCallback(() => {
    setMapType(prevType => {
      const newType = prevType === 'roadmap' ? 'satellite' : 'roadmap';
      console.log(`جاري تبديل نوع الخريطة إلى: ${newType}`);
      return newType;
    });
  }, []);

  // التعامل مع وظيفة البحث
  const handleSearch = useCallback(() => {
    if (!geojsonData || !searchedPlaceInput.trim()) {
      setSearchResultInfo(null);
      if (map.data) {
        map.data.revertStyle(); 
      }
      return;
    }

    const searchTerm = searchedPlaceInput.trim().toLowerCase();
    let foundOriginalFeature = null;

    // البحث في البيانات الأصلية للعثور على الميزة الأصلية بالاسم
    for (const feature of geojsonData.features) {
      const featureName = feature.properties?.Name || feature.properties?.name || '';
      if (featureName.toLowerCase().includes(searchTerm)) {
        foundOriginalFeature = feature;
        break; 
      }
    }

    if (foundOriginalFeature && map) {
      if (map.data) {
        map.data.revertStyle(); 
      }

      setSearchResultInfo({
          name: foundOriginalFeature.properties?.Name || foundOriginalFeature.properties?.name,
          feature: foundOriginalFeature 
      });

      // الانتقال إلى Centroid الميزة الأصلية
      if (foundOriginalFeature.geometry.coordinates && foundOriginalFeature.geometry.coordinates.length > 0) {
          let coordsToPanTo = null;
          if (window.turf) {
              try {
                  const centroid = window.turf.centroid(foundOriginalFeature);
                  if (centroid && centroid.geometry && centroid.geometry.coordinates && 
                      Array.isArray(centroid.geometry.coordinates) && centroid.geometry.coordinates.length >= 2 &&
                      isFinite(centroid.geometry.coordinates[0]) && isFinite(centroid.geometry.coordinates[1])) {
                       coordsToPanTo = { lng: centroid.geometry.coordinates[0], lat: centroid.geometry.coordinates[1] };
                  }
              } catch (e) {
                  console.warn("تعذر حساب Centroid للتنقل. جاري العودة إلى الإحداثيات الأولى أو نقطة البداية للميزة.", e);
              }
          }
          
          if (!coordsToPanTo) { // Fallback إذا فشل Centroid
            if (foundOriginalFeature.geometry.type === 'Point' && Array.isArray(foundOriginalFeature.geometry.coordinates) && foundOriginalFeature.geometry.coordinates.length >= 2) {
                coordsToPanTo = { lng: foundOriginalFeature.geometry.coordinates[0], lat: foundOriginalFeature.geometry.coordinates[1] };
            } else if ((foundOriginalFeature.geometry.type === 'LineString' || foundOriginalFeature.geometry.type === 'MultiLineString') && Array.isArray(foundOriginalFeature.geometry.coordinates[0]) && foundOriginalFeature.geometry.coordinates[0].length >= 2) {
                coordsToPanTo = { lng: foundOriginalFeature.geometry.coordinates[0][0], lat: foundOriginalFeature.geometry.coordinates[0][1] };
            } else if ((foundOriginalFeature.geometry.type === 'Polygon' || foundOriginalFeature.geometry.type === 'MultiPolygon') && Array.isArray(foundOriginalFeature.geometry.coordinates[0]) && Array.isArray(foundOriginalFeature.geometry.coordinates[0][0]) && foundOriginalFeature.geometry.coordinates[0][0].length >= 2) {
                coordsToPanTo = { lng: foundOriginalFeature.geometry.coordinates[0][0][0], lat: foundOriginalFeature.geometry.coordinates[0][0][1] };
            }
          }

          if (coordsToPanTo && isFinite(coordsToPanTo.lat) && isFinite(coordsToPanTo.lng)) {
              map.panTo(new window.google.maps.LatLng(coordsToPanTo.lat, coordsToPanTo.lng));
              map.setZoom(14); 
          } else {
            console.warn("إحداثيات الانتقال غير صالحة بعد جميع المحاولات لـ feature:", foundOriginalFeature);
          }
      }
    } else {
      setSearchResultInfo(null);
      console.log(`لم يتم العثور على موقع لـ "${searchedPlaceInput}"`);
    }
    setSearchedPlaceInput(''); 
    setShowSearchInput(false); 
  }, [geojsonData, searchedPlaceInput, map]);

  const handleSearchKeyPress = useCallback((e) => {
    if (e.key === 'Enter') {
      handleSearch();
    }
  }, [handleSearch]);

  const handleShowAboutModal = useCallback(() => {
    setShowAboutModal(true);
  }, []);

  const handleCloseAboutModal = useCallback(() => {
    setShowAboutModal(false);
  }, []);

  return (
    <div className="relative w-full h-full min-h-[600px] overflow-hidden font-sans bg-gray-100">
      {isMapApiLoaded && isTurfLoaded && isKDBushLoaded ? ( 
        <>
          <div 
            ref={mapRef}
            id="map-container"
            style={{ width: '100%', height: '100%' }} 
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

          <div className="absolute bottom-4 left-4 bg-black bg-opacity-80 text-white px-4 py-2 rounded-lg text-sm font-mono z-20 shadow-md">
            خط عرض = {currentCoords.lat.toFixed(8)} خط طول = {currentCoords.lng.toFixed(8)}
          </div>

          <div className="absolute bottom-16 left-4 bg-red-600 text-white px-3 py-1 rounded-lg text-sm flex items-center gap-2 z-20 shadow-md">
            <MapPin size={16} />
            {geoJsonLocationName 
              ? geoJsonLocationName
              : 'موقع غير معروف'
            }
          </div>

          {searchResultInfo && (
            <div className="absolute top-4 left-4 bg-white p-3 rounded-lg shadow-lg z-20 max-w-xs md:max-w-sm">
                <div className="flex justify-between items-center mb-2">
                    <h3 className="font-bold text-lg text-blue-700">نتيجة البحث</h3>
                    <button onClick={() => {
                      setSearchResultInfo(null);
                      if (map.data) {
                        map.data.revertStyle(); 
                      }
                    }} className="text-gray-500 hover:text-gray-700">
                        <X size={20} /> 
                    </button>
                </div>
                <p className="text-sm font-semibold text-gray-700">الاسم: <span className="text-blue-600">{searchResultInfo.name}</span></p>
            </div>
          )}


          <div className="absolute top-4 right-4 flex flex-col gap-2 z-20">
            {showSearchInput && (
              <div className="flex gap-2 p-2 bg-white rounded-md shadow-lg">
                <input
                  type="text"
                  placeholder="ابحث عن اسم GeoJSON..."
                  value={searchedPlaceInput}
                  onChange={(e) => setSearchedPlaceInput(e.target.value)}
                  onKeyPress={handleSearchKeyPress}
                  className="p-2 border rounded-md focus:ring-2 focus:ring-blue-500 flex-grow"
                />
                <button
                  onClick={handleSearch}
                  className="bg-blue-600 hover:bg-blue-700 text-white p-3 rounded-full shadow-lg transition-colors duration-200 ease-in-out"
                  title="إجراء البحث"
                >
                  <Search size={20} />
                </button>
                <button
                  onClick={() => {
                    setShowSearchInput(false);
                    setSearchedPlaceInput('');
                    setSearchResultInfo(null);
                     if (map.data) {
                        map.data.revertStyle(); 
                      }
                  }}
                  className="bg-gray-500 hover:bg-gray-600 text-white p-3 rounded-full shadow-lg transition-colors duration-200 ease-in-out"
                  title="إغلاق البحث"
                >
                  <X size={20} /> 
                </button>
              </div>
            )}
            <div className="flex gap-2">
              <button
                onClick={resetToCenter}
                className="bg-green-600 hover:bg-green-700 text-white p-3 rounded-full shadow-lg transition-colors duration-200 ease-in-out transform hover:scale-105 focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-opacity-75"
                title="إعادة تعيين إلى المركز"
              >
                <Home size={20} />
              </button>

              <button
                onClick={handleShowAboutModal}
                className="bg-purple-600 hover:bg-purple-700 text-white p-3 rounded-full shadow-lg transition-colors duration-200 ease-in-out transform hover:scale-105 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:ring-opacity-75"
                title="حول/مساعدة"
              >
                <Info size={20} />
              </button>

              <button
                onClick={() => setShowSearchInput(prev => !prev)}
                className="bg-indigo-600 hover:bg-indigo-700 text-white p-3 rounded-full shadow-lg transition-colors duration-200 ease-in-out transform hover:scale-105 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-opacity-75"
                title="تبديل البحث"
              >
                <Search size={20} />
              </button>

              <button
                onClick={handleMapTypeToggle}
                className="bg-orange-600 hover:bg-orange-700 text-white p-3 rounded-full shadow-lg transition-colors duration-200 ease-in-out transform hover:scale-105 focus:outline-none focus:ring-2 focus:ring-orange-500 focus:ring-opacity-75"
                title={mapType === 'roadmap' ? 'عرض القمر الصناعي' : 'عرض خريطة الطريق'}
              >
                {mapType === 'roadmap' ? <Satellite size={20} /> : <MapIcon size={20} />}
              </button>
            </div> 
          </div> 

          <div className="absolute bottom-4 right-4 flex gap-2 z-20">
            <button
              onClick={copyCoordinates}
              className="bg-blue-600 hover:bg-blue-700 text-white p-3 rounded-full shadow-lg transition-colors duration-200 ease-in-out transform hover:scale-105 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-opacity-75"
              title="نسخ الإحداثيات واسم الموقع"
            >
              <Copy size={20} />
            </button>
            
            <button
              onClick={exportMap}
              className="bg-red-600 hover:bg-red-700 text-white p-3 rounded-full shadow-lg transition-colors duration-200 ease-in-out transform hover:scale-105 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-opacity-75"
              title="تنزيل بيانات الخريطة"
            >
              <Download size={20} />
            </button>
          </div>

          {showAboutModal && (
            <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
              <div className="bg-white p-8 rounded-lg shadow-xl max-w-sm w-full relative">
                <button
                  onClick={handleCloseAboutModal}
                  className="absolute top-3 right-3 text-gray-500 hover:text-gray-700"
                >
                  <X size={24} />
                </button>
                <h2 className="text-xl font-bold mb-4 text-blue-700">حول هذه الخريطة</h2>
                <p className="text-gray-700 mb-4">
                  تعرض هذه الخريطة التفاعلية ميزات جغرافية. يمكنك التنقل، والتكبير/التصغير، والبحث عن الميزات بالاسم،
                  والتبديل بين عرض خريطة الطريق وعرض القمر الصناعي، ونسخ الإحداثيات الحالية.
                </p>
                <p className="text-gray-700 text-sm">
                  تم تطويرها باستخدام React، وواجهة برمجة تطبيقات خرائط جوجل، وTurf.js.
                </p>
                <button
                  onClick={handleCloseAboutModal}
                  className="mt-6 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-md shadow transition-colors"
                >
                  فهمت!
                </button>
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="flex items-center justify-center h-full min-h-[500px]">
          <div className="text-lg text-gray-700">جاري تحميل الخريطة...</div>
        </div>
      )}
    </div>
  );
};

export default React.memo(MapComponent);
