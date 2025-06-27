import React, { useState, useEffect, useCallback, useRef } from 'react';
import { MapPin, Copy, Download, Home, Info, Search, Satellite, Map as MapIcon, X } from 'lucide-react'; // تم إضافة 'X' هنا للزر إغلاق

// الإحداثيات الأولية لمركز الخريطة
const initialMapCenter = {
  lat: 30.885, // خط العرض التقريبي لـ 'جرارا معنيا'
  lng: 30.625 // خط الطول التقريبي لـ 'جرارا معنيا'
};

// تحديد أقصى مسافة (بالكيلومترات) لاعتبار نقطة "على" أو "بالقرب من" خط
const MAX_DISTANCE_TO_LINE_KM = 5.0; // 5 كيلومترات لتحقيق توازن جيد بين سهولة الكشف والدقة

// تأخير Debounce بالمللي ثانية لتحديثات الموقع
const DEBOUNCE_DELAY_MS = 150; 

// --- بداية KDBush المضمنة ---
// KDBush هي شجرة R ثابتة سريعة للنقاط ثنائية الأبعاد.
// هذا الإصدار المبسّط للعرض التوضيحي.
class KDBush {
  constructor(points) {
    this.points = points; 
    this.ids = [];
    this.coords = [];
    this.tree = []; // لم يتم تطبيقها بالكامل كشجرة للتبسيط في النطاق، ولكن init ينشئ معرفات مرتبة
    this.nodeSize = 64; 
    this.init();
  }

  init() {
    for (let i = 0; i < this.points.length; i++) {
      this.ids[i] = i; // تخزين الفهرس الأصلي
      this.coords[2 * i] = this.points[i].x; // خط الطول
      this.coords[2 * i + 1] = this.points[i].y; // خط العرض
    }
    this.sort(0, this.ids.length - 1, 0);
  }

  // تطبيق Quicksort (مبسط)
  sort(left, right, axis) {
    if (right - left <= this.nodeSize) return;
    const median = left + Math.floor((right - left) / 2);
    this.select(left, right, median, axis);
    this.sort(left, median - 1, 1 - axis);
    this.sort(median + 1, right, 1 - axis);
  }

  // يحدد العنصر k-th (للتقسيم)
  select(left, right, k, axis) {
    while (right > left) {
      if (right - left > 600) { /* تحسين للمصفوفات الكبيرة جدًا، تم حذفه للإيجاز */ }
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

  // بحث نطاق أساسي عن طريق التكرار عبر جميع النقاط والتحقق من مربع التحديد
  // لشجرة KDBush حقيقية، سيتضمن ذلك اجتياز الشجرة.
  range(minX, minY, maxX, maxY) {
    const results = [];
    for (let i = 0; i < this.ids.length; i++) {
      const id = this.ids[i]; 
      const x = this.coords[2 * id];
      const y = this.coords[2 * id + 1];
      if (x >= minX && x <= maxX && y >= minY && y <= maxY) {
        results.push(id); // إرجاع الفهرس الأصلي للميزة
      }
    }
    return results;
  }
  finish() { /* لا توجد عملية لهذا التنفيذ المبسط */ }
}
// --- نهاية KDBush المضمنة ---


const MapComponent = () => {
  const [isMapApiLoaded, setIsMapApiLoaded] = useState(false);
  const [isTurfLoaded, setIsTurfLoaded] = useState(false);
  const [isKDBushLoaded] = useState(true); // KDBush مضمن، لذا فهو دائمًا "محمل"
  
  const [map, setMap] = useState(null);
  const [geojsonData, setGeojsonData] = useState(null);
  const [currentCoords, setCurrentCoords] = useState({ lat: initialMapCenter.lat, lng: initialMapCenter.lng });
  const [geoJsonLocationName, setGeoJsonLocationName] = useState(null);

  const [spatialIndex, setSpatialIndex] = useState(null);

  const debounceTimeoutRef = useRef(null);
  const mapRef = useRef(null); // Ref لعنصر div الخاص بوعاء الخريطة

  // Refs للاحتفاظ بأحدث إصدارات دوال رد الاتصال للمكالمات المؤجلة/المحددة
  // هذا يتجنب إغلاقات قديمة داخل setTimeout/setInterval
  const updateLocationDisplayRef = useRef();
  const debouncedUpdateLocationDisplayRef = useRef();

  // حالات جديدة لعناصر التحكم التفاعلية
  const [showSearchInput, setShowSearchInput] = useState(false);
  const [searchedPlaceInput, setSearchedPlaceInput] = useState('');
  const [searchResultInfo, setSearchResultInfo] = useState(null);
  const [showAboutModal, setShowAboutModal] = useState(false);
  const [mapType, setMapType] = useState('roadmap'); // 'roadmap' أو 'satellite'
  const [cursorIconType, setCursorIconType] = useState('default'); // 'default' أو 'home'
  const highlightFeatureRef = useRef(null); // Ref لتخزين ميزة بيانات خرائط جوجل للتظليل

  // دالة لتحميل السكربت الخارجي والاستقصاء عن كائنه العام
  const loadExternalScript = useCallback((src, id, globalVarName, setLoadedState) => {
    return new Promise((resolve) => {
      // التحقق مما إذا كان السكربت موجودًا بالفعل في المستند
      if (document.getElementById(id)) {
        console.log(`السكربت ${id} موجود بالفعل. جاري التحقق من الكائن العام.`);
        // الاستقصاء عن المتغير العام على الفور، في حال تم تحميله ولكنه غير متاح بعد
        pollForGlobal(globalVarName, setLoadedState, resolve, id);
        return;
      }

      const script = document.createElement('script');
      script.src = src;
      script.id = id;
      script.async = true; // التحميل بشكل غير متزامن
      script.defer = true; // تأجيل التنفيذ حتى يتم تحليل HTML
      script.onload = () => {
        console.log(`السكربت ${id} تم تحميله. جاري الاستقصاء عن ${globalVarName}...`);
        pollForGlobal(globalVarName, setLoadedState, resolve, id);
      };
      script.onerror = () => {
        console.error(`خطأ في تحميل السكربت: ${src}. جاري تعيين حالة ${id} إلى false.`);
        setLoadedState(false); // تمييز على أنه لم يتم تحميله عند حدوث خطأ
        resolve(); // حل الوعد حتى عند حدوث خطأ لإلغاء حظر عمليات التحميل الأخرى
      };
      document.head.appendChild(script); // إلحاق السكربت بالرأس
    });
  }, []);

  // دالة مساعدة للاستقصاء عن متغير عام للتأكد من توفره
  const pollForGlobal = useCallback((globalVarName, setLoadedState, resolvePromise, scriptId, attempts = 0) => {
    const maxAttempts = 50; // الحد الأقصى لمحاولات العثور على المتغير العام
    const intervalTime = 100; // الوقت بين المحاولات بالمللي ثانية

    if (window[globalVarName]) {
      // تم العثور على المتغير العام، تحديث الحالة وحل الوعد
      console.log(`تم العثور على الكائن العام ${globalVarName} من ${scriptId} بعد ${attempts * intervalTime} مللي ثانية.`);
      setLoadedState(true);
      resolvePromise();
    } else if (attempts < maxAttempts) {
      // لم يتم العثور عليه بعد، جرب مرة أخرى بعد intervalTime
      setTimeout(() => {
        pollForGlobal(globalVarName, setLoadedState, resolvePromise, scriptId, attempts + 1);
      }, intervalTime);
    } else {
      // تم الوصول إلى الحد الأقصى للمحاولات، مهلة
      console.error(`انتهت المهلة: لم يتم العثور على الكائن العام ${globalVarName} من ${scriptId} بعد ${maxAttempts} محاولة.`);
      setLoadedState(false); // تمييز على أنه لم يتم تحميله
      resolvePromise(); // حل على أي حال لمنع حالة تحميل لا نهائية
    }
  }, []);

  // 1. تحميل واجهة برمجة تطبيقات خرائط جوجل وسكربت Turf.js
  // يتم تشغيل هذا التأثير مرة واحدة عند تحميل المكون لبدء تحميل السكربت
  useEffect(() => {
    // هام: يرجى استبدال 'YOUR_GOOGLE_MAPS_API_KEY' بمفتاح Google Maps API الفعلي الخاص بك.
    // يجب الحصول على هذا المفتاح من Google Cloud Console، وتأكد من تمكين Maps JavaScript API.
    // أيضًا، تحقق من تمكين الفوترة لمشروع Google Cloud الخاص بك المرتبط بمفتاح API.
    // إذا كنت تعمل محليًا، تأكد من عدم وجود قيود على HTTP referrer تمنع 'localhost'.
    // إذا تم النشر، تأكد من تعيين قيود HTTP referrer الصحيحة لنطاقك.
    const googleMapsApiKey = "AIzaSyC5MHgv-Vax9PJqB2kROWaiVYD5AtFHnIc" ; 

    // تعريف initMap عالميًا قبل تحميل سكربت خرائط جوجل.
    // يتم تشغيل رد الاتصال هذا بواسطة سكربت Google Maps API نفسه بمجرد تحميله.
    window.initMap = () => { 
      console.log("تم تشغيل رد اتصال Google Maps initMap.");
      setIsMapApiLoaded(true); // تحديث الحالة للإشارة إلى أن واجهة برمجة التطبيقات جاهزة
    };

    const loadLibraries = async () => {
      console.log("جاري بدء تحميل المكتبات الخارجية الأساسية...");
      try {
        await loadExternalScript(
          `https://maps.googleapis.com/maps/api/js?key=${googleMapsApiKey}&callback=initMap`,
          'google-map-script',
          'google', // اسم الكائن العام لخرائط جوجل
          setIsMapApiLoaded
        );
        
        await loadExternalScript(
          'https://cdnjs.cloudflare.com/ajax/libs/Turf.js/5.1.6/turf.min.js', 
          'turf-script',
          'turf', // اسم الكائن العام لـ Turf.js
          setIsTurfLoaded
        );

        console.log("تم بدء عملية تحميل المكتبات الخارجية. تحقق من حالات التحميل الفردية في السجلات.");

      } catch (error) {
        console.error("فشل في بدء تحميل واحدة أو أكثر من المكتبات الخارجية:", error);
      }
    };

    loadLibraries();
  }, [loadExternalScript]); // الاعتماد على loadExternalScript للتأكد من ثباته

  // 2. جلب بيانات GeoJSON من '/d_wgs84.json'
  // يتم جلب بيانات GeoJSON مرة واحدة عند تحميل المكون.
  useEffect(() => {
    // تأكد من أن هذا المسار يشير إلى ملف GeoJSON الذي تم إعادة إسقاطه (مثل d_wgs84.json)
    fetch('/d_wgs84.json') 
      .then(response => {
        if (!response.ok) {
          throw new Error(`خطأ HTTP! الحالة: ${response.status}`);
        }
        return response.json();
      })
      .then(data => {
        setGeojsonData(data);
        console.log("تم جلب بيانات GeoJSON بنجاح من d_wgs84.json. عدد الميزات:", data.features ? data.features.length : 0);
      })
      .catch(error => {
        console.error("خطأ في جلب GeoJSON من d_wgs84.json:", error);
      });
  }, []); // مصفوفة الاعتمادية فارغة مما يعني أنها تعمل مرة واحدة فقط عند التحميل

  // 3. checkPointInGeoJSON المحسّنة باستخدام الفهرس المكاني (KDBush) وTurf.js
  // يتم تذكير هذه الدالة باستخدام useCallback لتحسين الأداء.
  const checkPointInGeoJSON = useCallback((lat, lng) => {
    console.groupCollapsed(`تم استدعاء checkPointInGeoJSON لـ خط عرض: ${lat.toFixed(6)}, خط طول: ${lng.toFixed(6)}`);

    // التحقق مما إذا كانت جميع الاعتماديات الضرورية جاهزة قبل المتابعة
    if (!geojsonData || !spatialIndex || !isTurfLoaded || !isKDBushLoaded || !window.turf) {
        console.log("الاعتماديات غير جاهزة لـ checkPointInGeoJSON. جاري تخطي التحقق.");
        console.log("حالات الاعتمادية الحالية:", { geojsonData: !!geojsonData, spatialIndex: !!spatialIndex, isTurfLoaded, isKDBushLoaded, turf: !!window.turf });
        console.groupEnd();
        return null; 
    }

    const queryPoint = window.turf.point([lng, lat]); 

    let nearestFeatureName = null;
    let minDistance = Infinity; 

    // حساب نصف قطر البحث بالدرجات لبحث مربع التحديد الخاص بـ KDBush
    const searchRadiusDegrees = MAX_DISTANCE_TO_LINE_KM / 111.32; // كيلومتر تقريبي لكل درجة عرض

    const minLng = lng - searchRadiusDegrees;
    const maxLng = lng + searchRadiusDegrees;
    const minLat = lat - searchRadiusDegrees;
    const maxLat = lat + searchRadiusDegrees;

    // استخدام KDBush للعثور بسرعة على الميزات المحتملة داخل مربع التحديد
    const potentialFeatureIndices = spatialIndex.index.range(minLng, minLat, maxLng, maxLat);
    console.log(`وجد KDBush ${potentialFeatureIndices.length} ميزة محتملة في مربع التحديد [${minLng.toFixed(4)}, ${minLat.toFixed(4)}, ${maxLng.toFixed(4)}, ${maxLat.toFixed(4)}].`);

    if (potentialFeatureIndices.length === 0) {
        console.log("لم يتم العثور على ميزات في المنطقة المجاورة المباشرة بواسطة بحث نطاق KDBush.");
        console.groupEnd();
        return null; 
    }

    // التكرار عبر الميزات المحتملة لإجراء تحليل مكاني أكثر دقة باستخدام Turf.js
    for (const originalIndex of potentialFeatureIndices) {
      const feature = spatialIndex.featureMap.get(originalIndex); 
      if (!feature || !feature.geometry) {
        console.log(`تخطي ميزة غير صالحة في الفهرس الأصلي ${originalIndex}.`);
        continue;
      }

      // الوصول القوي لاسم الميزة، والتحقق من 'Name' (بحرف كبير) أولاً
      const featureName = feature.properties?.Name || feature.properties?.name || 'ميزة غير مسماة';
      console.log(`جاري تقييم الميزة (الفهرس الأصلي: ${originalIndex}): النوع=${feature.geometry.type}, الاسم="${featureName}"`);

      // التعامل مع أنواع Polygon و MultiPolygon (التحقق من النقطة في المضلع)
      if (feature.geometry.type === 'Polygon' || feature.geometry.type === 'MultiPolygon') {
        try {
            if (window.turf.booleanPointInPolygon(queryPoint, feature)) {
                nearestFeatureName = featureName;
                console.log(`النقطة داخل المضلع: "${nearestFeatureName}". جاري الإرجاع فورًا.`);
                console.groupEnd();
                return nearestFeatureName; 
            }
        } catch (e) {
            console.warn(`خطأ في booleanPointInPolygon للميزة ("${featureName}"):`, e);
        }
      } 
      // التعامل مع أنواع LineString و MultiLineString (التحقق من مسافة النقطة إلى الخط)
      else if (feature.geometry.type === 'LineString' || feature.geometry.type === 'MultiLineString') {
        try {
          const distance = window.turf.pointToLineDistance(queryPoint, feature, { units: 'kilometers' });
          console.log(`المسافة إلى LineString ("${featureName}"): ${distance.toFixed(3)} كم.`);

          if (distance < minDistance && distance <= MAX_DISTANCE_TO_LINE_KM) {
            minDistance = distance; 
            nearestFeatureName = featureName;
            console.log(`تم العثور على خط أقرب ضمن النطاق: "${nearestFeatureName}" على مسافة ${distance.toFixed(3)} كم.`);
          }
        } catch (e) {
          console.warn(`خطأ في حساب pointToLineDistance للميزة ("${featureName}"):`, e);
        }
      } else {
          console.log(`نوع الميزة "${feature.geometry.type}" غير مدعوم لعمليات التحقق من القرب/الاحتواء.`);
      }
    }
    
    // النتيجة النهائية بعد التحقق من جميع الميزات المحتملة
    const finalResult = nearestFeatureName || null;
    console.log(`النتيجة النهائية لـ خط عرض: ${lat.toFixed(6)}, خط طول: ${lng.toFixed(6)}: تم العثور على: "${finalResult || 'لا شيء'}".`);
    console.groupEnd();
    return finalResult;
  }, [geojsonData, spatialIndex, isTurfLoaded, isKDBushLoaded, MAX_DISTANCE_TO_LINE_KM]); 

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


  // 5. بناء الفهرس المكاني باستخدام KDBush عندما يتم تحميل geojsonData وTurf.js
  useEffect(() => {
    // بناء الفهرس فقط إذا تم استيفاء جميع الاعتماديات ولم يتم بناء الفهرس المكاني بعد (هو null)
    if (geojsonData && geojsonData.features && isKDBushLoaded && isTurfLoaded && window.turf && spatialIndex === null) {
      console.log("جاري محاولة بناء الفهرس المكاني...");
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
                            // العودة إلى الإحداثيات الأولى للخطوط/المضلعات إذا كان Centroid غير صالح أو [0,0]
                            if ((feature.geometry.type === 'LineString' || feature.geometry.type === 'MultiLineString') && feature.geometry.coordinates[0] && feature.geometry.coordinates[0].length >= 2 &&
                                isFinite(feature.geometry.coordinates[0][0]) && isFinite(feature.geometry.coordinates[0][1])) {
                                representativePoint = feature.geometry.coordinates[0]; 
                                console.warn(`Turf.js centroid كان غير صالح للميزة (الفهرس: ${index}, الاسم: ${feature.properties?.Name || 'غير مسمى'}). جاري العودة إلى الإحداثيات الأولى:`, representativePoint);
                            } else if ((feature.geometry.type === 'Polygon' || feature.geometry.type === 'MultiPolygon') && feature.geometry.coordinates[0] && feature.geometry.coordinates[0][0] && feature.geometry.coordinates[0][0].length >= 2 &&
                                isFinite(feature.geometry.coordinates[0][0][0]) && isFinite(feature.geometry.coordinates[0][0][1])) {
                                representativePoint = feature.geometry.coordinates[0][0]; 
                                console.warn(`Turf.js centroid كان غير صالح للميزة (الفهرس: ${index}, الاسم: ${feature.properties?.Name || 'غير مسمى'}). جاري العودة إلى إحداثيات المضلع الأولى:`, representativePoint);
                            } else {
                                console.warn(`أرجع Turf.js centroid كائنًا/إحداثيات غير صالحة للميزة (الفهرس: ${index}, النوع: ${feature.geometry.type}, الاسم: ${feature.properties?.Name || 'غير مسمى'}) وفشل في العودة - جاري تخطي الفهرسة.`);
                                return; 
                            }
                        }
                    } catch (e) {
                        console.warn(`فشل turf.centroid للميزة (الفهرس: ${index}, النوع: ${feature.geometry.type}, الاسم: ${feature.properties?.Name || 'غير مسمى'}) - جاري تخطي الفهرسة:`, e);
                        return; 
                    }
                } else {
                    console.warn(`إحداثيات غير صالحة أو فارغة لنوع هندسة الميزة (الفهرس: ${index}, النوع: ${feature.geometry.type}) - جاري تخطي حساب Centroid:`, feature.geometry.coordinates);
                    return; 
                }
            } else {
                console.warn("Turf.js غير متاح لحساب Centroid أثناء بناء الفهرس المكاني.");
                return; 
            }
            
            // التحقق النهائي من representativePoint قبل الإضافة إلى الفهرس
            if (representativePoint && Array.isArray(representativePoint) && representativePoint.length >= 2 && 
                isFinite(representativePoint[0]) && isFinite(representativePoint[1])) {
              pointsToIndex.push({
                x: representativePoint[0], // خط الطول
                y: representativePoint[1], // خط العرض
                featureIndex: index 
              });
              featureMap.set(index, feature); 
            } else {
              console.warn(`جاري تخطي الميزة (الفهرس: ${index}, الاسم: ${feature.properties?.Name || 'غير مسمى'}) بسبب نقطة تمثيل نهائية غير صالحة (NaN/Infinity أو مشوهة بعد التحقق):`, representativePoint);
            }
          } catch (e) {
            console.error(`خطأ فادح في معالجة الميزة (الفهرس: ${index}, الاسم: ${feature.properties?.Name || 'غير مسمى'}) للفهرسة:`, feature, e);
          }
        } else {
          console.warn(`جاري تخطي الميزة (الفهرس: ${index}) بدون هندسة.`);
        }
      });

      if (pointsToIndex.length > 0) {
        const index = new KDBush(pointsToIndex); 
        index.finish(); 

        setSpatialIndex({ index, featureMap });
        console.log(`تم بناء الفهرس المكاني بنجاح مع ${pointsToIndex.length} نقطة.`);
        console.log("عينة من النقاط المفهرسة (أول 5):", pointsToIndex.slice(0, 5)); 
        console.log("عينة من قيم featureMap (أول 5 أسماء):", Array.from(featureMap.values()).slice(0, 5).map(f => f.properties?.Name || f.properties?.name));
      } else {
        console.warn("لم يتم العثور على نقاط صالحة لبناء الفهرس المكاني. سيكون الفهرس المكاني null. تحقق من بيانات GeoJSON ومنطق حساب Centroid.");
        setSpatialIndex(null); 
      }
    } else {
        console.log("تم تخطي بناء الفهرس المكاني. الاعتماديات لم يتم استيفائها بالكامل بعد أو تم بناء الفهرس المكاني بالفعل:", { geojsonData: !!geojsonData, isKDBushLoaded, isTurfLoaded, turf: !!window.turf, spatialIndex: !!spatialIndex });
    }
  }, [geojsonData, isTurfLoaded, isKDBushLoaded, spatialIndex]); // إضافة spatialIndex إلى الاعتماديات

  // 6. تهيئة خريطة جوجل وإرفاق مستمعي الأحداث
  useEffect(() => {
    // تابع فقط إذا تم تحميل واجهة برمجة التطبيقات، وتم إرفاق mapRef بالـ DOM، ولم يتم إنشاء الخريطة بعد.
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
        clickableIcons: false, // يمنع سلوك النقر الافتراضي على نقاط الاهتمام المضمنة في جوجل
        mapTypeId: mapType // تعيين نوع الخريطة الأولي
      };

      const googleMapInstance = new window.google.maps.Map(mapRef.current, mapOptions);
      setMap(googleMapInstance); // تخزين كائن الخريطة في الحالة

      // إجراء فحص الموقع الأولي عند تحميل الخريطة
      const currentMapCenter = googleMapInstance.getCenter();
      if (currentMapCenter) {
        const lat = currentMapCenter.lat();
        const lng = currentMapCenter.lng();
        setCurrentCoords({ lat, lng });
        if (updateLocationDisplayRef.current) {
          updateLocationDisplayRef.current(lat, lng); 
        } else {
          console.warn("updateLocationDisplayRef غير جاهز أثناء تحديث مركز الخريطة الأولي. جاري تأخير الفحص الأولي.");
          // احتياطي: إذا لم يكن ref جاهزًا على الفور، جرب بعد تأخير قصير
          setTimeout(() => updateLocationDisplayRef.current && updateLocationDisplayRef.current(lat, lng), 500);
        }
      }

      // إضافة مستمع لتغييرات مركز الخريطة (يشغل فحص الموقع المؤجل)
      const centerChangedListener = googleMapInstance.addListener('center_changed', () => {
        const center = googleMapInstance.getCenter();
        if (center) {
          const lat = center.lat();
          const lng = center.lng();
          setCurrentCoords({ lat, lng }); // تحديث عرض الإحداثيات الحالية فورًا
          if (debouncedUpdateLocationDisplayRef.current) {
            debouncedUpdateLocationDisplayRef.current(lat, lng); 
          } else {
            console.warn("debouncedUpdateLocationDisplayRef غير جاهز أثناء تغيير مركز الخريطة.");
          }
        }
      });

      // دالة تنظيف لـ useEffect: إزالة المستمعين ومسح كائن الخريطة
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
  }, [isMapApiLoaded, mapRef.current, mapType]); // إضافة mapType إلى الاعتماديات لإعادة تهيئة الخريطة إذا تغير النوع

  // تحديث نوع الخريطة عند تغيير حالة mapType
  useEffect(() => {
    if (map && window.google) {
      map.setMapTypeId(mapType);
    }
  }, [map, mapType]);


  // 7. إضافة وتنسيق بيانات GeoJSON على الخريطة بمجرد أن تصبح الخريطة، geojsonData، وTurf.js جاهزين
  useEffect(() => {
    if (map && geojsonData && isTurfLoaded && window.turf) { 
      console.log("جاري إضافة وتنسيق بيانات GeoJSON على الخريطة...");
      // مسح طبقات GeoJSON الموجودة قبل إضافة طبقات جديدة
      map.data.forEach(feature => map.data.remove(feature));
      map.data.addGeoJson(geojsonData); // إضافة بيانات GeoJSON الخاصة بك إلى الخريطة

      // تعريف النمط الافتراضي لميزات GeoJSON
      const defaultFeatureStyle = {
        strokeColor: '#0070ff', // لون أزرق للخطوط
        strokeWeight: 4,        // خطوط سميكة
        strokeOpacity: 0.8,     // شبه شفافة
        fillColor: '#0000FF',   // تعبئة زرقاء للمضلعات
        fillOpacity: 0.5        // تعبئة شبه شفافة للمضلعات
      };

      // تعيين النمط لميزات GeoJSON، وتطبيق التظليل إذا كان ينطبق
      map.data.setStyle(feature => {
        const featureName = feature.properties?.Name || feature.properties?.name;
        // التحقق مما إذا كانت هذه الميزة هي الميزة المظللة حاليًا
        const isHighlighted = searchResultInfo && searchResultInfo.feature && 
                              (searchResultInfo.feature.properties?.Name === featureName || 
                               searchResultInfo.feature.properties?.name === featureName);

        if (isHighlighted) {
          // إذا كانت مظللة، قم بتخزين مرجع لكائن ميزة بيانات خرائط جوجل هذا
          // يسمح لنا ذلك بمسح نمطه لاحقًا دون إعادة إضافة جميع GeoJSON
          highlightFeatureRef.current = feature;
          return {
            strokeColor: '#FF0000', // أحمر للمميز
            strokeWeight: 6,         // أكثر سمكًا للمميز
            strokeOpacity: 1.0,
            fillColor: '#FF0000',
            fillOpacity: 0.7
          };
        }
        // إرجاع النمط الافتراضي إذا لم يتم تمييزه
        return defaultFeatureStyle;
      });

      // ضبط حدود الخريطة لتناسب بيانات GeoJSON إذا تم العثور على إحداثيات صالحة
      const bounds = new window.google.maps.LatLngBounds();
      let hasValidCoordsInFeatures = false; 

      geojsonData.features.forEach(feature => {
        if (feature.geometry && feature.geometry.coordinates) {
          try {
            const bbox = window.turf.bbox(feature); // حساب مربع التحديد باستخدام Turf.js
            // التحقق مما إذا كان bbox صالحًا ويحتوي على أرقام محدودة
            if (bbox && bbox.length === 4 && bbox.every(coord => typeof coord === 'number' && isFinite(coord))) { 
              // توسيع حدود خرائط جوجل باستخدام bbox للميزة
              bounds.extend(new window.google.maps.LatLng(bbox[1], bbox[0])); // الجنوب الغربي
              bounds.extend(new window.google.maps.LatLng(bbox[3], bbox[2])); // الشمال الشرقي
              hasValidCoordsInFeatures = true;
            } else {
                 console.warn("تم حساب bbox غير صالح للميزة (إحداثيات غير محدودة أو مشوهة)، جاري تخطي توسيع الحدود:", feature, bbox);
            }
          } catch (e) {
            console.warn("تعذر حساب bbox للميزة (من المحتمل أن تكون بنية هندسية غير صالحة لـ turf.bbox)، جاري تخطي توسيع الحدود:", feature, e);
          }
        }
      });

      if (hasValidCoordsInFeatures && !bounds.isEmpty()) {
        map.fitBounds(bounds);
        map.setZoom(Math.min(map.getZoom(), 15)); // تحديد التكبير بـ 15 للحصول على نظرة عامة أفضل، وتجنب التكبير القريب جدًا
        console.log("تم ضبط الخريطة على حدود GeoJSON.");
      } else {
        console.warn("لم يتم العثور على إحداثيات GeoJSON صالحة لضبط الحدود، جاري العودة إلى مركز الخريطة الأولي.");
        map.setCenter(initialMapCenter);
        map.setZoom(7);
      }
    } else {
        console.log("تم تخطي إضافة بيانات الخريطة/التنسيق. الاعتماديات لم يتم استيفائها بالكامل:", { map: !!map, geojsonData: !!geojsonData, isTurfLoaded, turf: !!window.turf });
    }
  }, [map, geojsonData, isTurfLoaded, searchResultInfo]); // إضافة searchResultInfo إلى الاعتماديات للتظليل

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
    // يمكنك إضافة ملاحظات مرئية مؤقتة هنا (مثل رسالة "تم النسخ!")
  }, [currentCoords, geoJsonLocationName]);

  // دالة لإعادة تعيين الخريطة إلى مركزها الأولي ومستوى التكبير
  const resetToCenter = useCallback(() => {
    if (map) {
      map.setCenter(initialMapCenter); 
      map.setZoom(7); 
      setCurrentCoords(initialMapCenter); 
      updateLocationDisplayRef.current(initialMapCenter.lat, initialMapCenter.lng);
      setCursorIconType('home'); // عرض أيقونة المنزل
      // إعادة تعيين بعد تأخير قصير
      setTimeout(() => setCursorIconType('default'), 1000); 

      // مسح أي تظليل بحث نشط
      if (searchResultInfo) {
        setSearchResultInfo(null);
        if (highlightFeatureRef.current && map.data) {
          map.data.revertStyle(); // إعادة نمط جميع الميزات إلى الافتراضي
          highlightFeatureRef.current = null;
        }
      }
    }
  }, [map, searchResultInfo]);

  // عنصر نائب لوظيفة تصدير الخريطة
  const exportMap = useCallback(() => {
    console.log('عنصر نائب لوظيفة تصدير الخريطة');
    // إذا كنت تحتاج حقًا إلى صورة للخريطة، فالأمر أكثر تعقيدًا.
    // فكر في مكتبات مثل html2canvas لالتقاط DOM، ولكن لها قيودًا مع عناصر القماش مثل الخرائط.
    // لتصدير بيانات GeoJSON، ستقوم بتحويل `geojsonData` إلى سلسلة نصية وتشغيل التنزيل.
    // مثال لتصدير بيانات GeoJSON (ليست صورة خريطة كاملة):
    // if (geojsonData) {
    //   const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(geojsonData, null, 2));
    //   const downloadAnchorNode = document.createElement('a');
    //   downloadAnchorNode.setAttribute("href", dataStr);
    //   downloadAnchorNode.setAttribute("download", "exported_geojson_data.json");
    //   document.body.appendChild(downloadAnchorNode);
    //   downloadAnchorNode.click();
    //   downloadAnchorNode.remove();
    //   console.log("تم تصدير بيانات GeoJSON.");
    // }
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
      // مسح أي تظليل نشط إذا كان حقل البحث فارغًا
      if (highlightFeatureRef.current && map.data) {
        map.data.revertStyle(); 
        highlightFeatureRef.current = null;
      }
      return;
    }

    const searchTerm = searchedPlaceInput.trim().toLowerCase();
    let foundFeature = null;

    // البحث في جميع الميزات عن تطابق الاسم
    for (const feature of geojsonData.features) {
      const featureName = feature.properties?.Name || feature.properties?.name || '';
      if (featureName.toLowerCase().includes(searchTerm)) {
        foundFeature = feature;
        break; 
      }
    }

    if (foundFeature && map) {
      // مسح أي تظليل سابق إن وجد
      if (highlightFeatureRef.current && map.data) {
        map.data.revertStyle(); // إعادة نمط الميزة المظللة السابقة
        highlightFeatureRef.current = null;
      }

      // العثور على كائن ميزة بيانات خرائط جوجل المحدد لتطبيق التظليل
      let googleDataFeatureToHighlight = null;
      map.data.forEach(dataFeature => {
        const dataFeatureName = dataFeature.getProperty('Name') || dataFeature.getProperty('name');
        if (dataFeatureName && dataFeatureName.toLowerCase() === foundFeature.properties?.Name?.toLowerCase()) {
          googleDataFeatureToHighlight = dataFeature;
        }
      });
      
      if (googleDataFeatureToHighlight) {
        // تطبيق نمط التظليل
        map.data.overrideStyle(googleDataFeatureToHighlight, {
            strokeColor: '#FF0000', // أحمر للمميز
            strokeWeight: 6,         // أكثر سمكًا للمميز
            strokeOpacity: 1.0,
            fillColor: '#FF0000',
            fillOpacity: 0.7
        });
        setSearchResultInfo({
            name: foundFeature.properties?.Name || foundFeature.properties?.name,
            feature: foundFeature
        });

        // الانتقال إلى الميزة
        if (foundFeature.geometry.coordinates && foundFeature.geometry.coordinates.length > 0) {
            let coordsToPanTo = null;
            if (foundFeature.geometry.type === 'Point') {
                coordsToPanTo = { lng: foundFeature.geometry.coordinates[0], lat: foundFeature.geometry.coordinates[1] };
            } else if (window.turf) {
                try {
                    const centroid = window.turf.centroid(foundFeature);
                    coordsToPanTo = { lng: centroid.geometry.coordinates[0], lat: centroid.geometry.coordinates[1] };
                } catch (e) {
                    console.warn("تعذر حساب Centroid للتنقل. جاري العودة إلى الإحداثيات الأولى.", e);
                    if (Array.isArray(foundFeature.geometry.coordinates[0]) && foundFeature.geometry.coordinates[0].length >= 2) {
                        coordsToPanTo = { lng: foundFeature.geometry.coordinates[0][0], lat: foundFeature.geometry.coordinates[0][1] };
                    }
                }
            } else if (Array.isArray(foundFeature.geometry.coordinates[0]) && foundFeature.geometry.coordinates[0].length >= 2) {
                coordsToPanTo = { lng: foundFeature.geometry.coordinates[0][0], lat: foundFeature.geometry.coordinates[0][1] };
            }

            if (coordsToPanTo) {
                map.panTo(new window.google.maps.LatLng(coordsToPanTo.lat, coordsToPanTo.lng));
                map.setZoom(14); // التكبير على الميزة التي تم العثور عليها
            }
        }
      } else {
        // تم العثور على الميزة في GeoJSON ولكن لم يتم إضافتها إلى map.data (لا ينبغي أن يحدث إذا عمل addGeoJson)
        setSearchResultInfo(null);
        console.warn(`الميزة "${searchTerm}" تم العثور عليها في GeoJSON ولكن ليس ككائن ميزة بيانات خرائط جوجل.`);
      }
    } else {
      setSearchResultInfo(null);
      // استخدم صندوق رسائل بدلاً من التنبيه
      console.log(`لم يتم العثور على موقع لـ "${searchedPlaceInput}"`);
      // يمكنك عرض رسالة مؤقتة في واجهة المستخدم بدلاً من console.log
    }
    setSearchedPlaceInput(''); // مسح حقل البحث
    setShowSearchInput(false); // إخفاء حقل البحث بعد البحث
  }, [geojsonData, searchedPlaceInput, map, searchResultInfo]);

  const handleSearchKeyPress = useCallback((e) => {
    if (e.key === 'Enter') {
      handleSearch();
    }
  }, [handleSearch]);

  // حول/مساعدة Modal
  const handleShowAboutModal = useCallback(() => {
    setShowAboutModal(true);
  }, []);

  const handleCloseAboutModal = useCallback(() => {
    setShowAboutModal(false);
  }, []);

  // JSX لمكون الخريطة
  return (
    <div className="relative w-full h-full min-h-[600px] overflow-hidden font-sans bg-gray-100">
      {/* التحقق مما إذا كانت جميع واجهات برمجة التطبيقات الضرورية محملة قبل عرض الخريطة */}
      {isMapApiLoaded && isTurfLoaded && isKDBushLoaded ? ( 
        <>
          {/* وعاء الخريطة div */}
          <div 
            ref={mapRef}
            id="map-container"
            style={{ width: '100%', height: '100%' }} /* ارتفاع كامل للحاوية */
            className="absolute inset-0 rounded-lg shadow-xl"
          ></div>

          {/* أيقونة المؤشر الثابتة في منتصف الشاشة */}
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-10 flex items-center justify-center pointer-events-none">
            {cursorIconType === 'default' ? (
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
            ) : (
                // أيقونة المنزل لملاحظات المؤشر
                <Home size={40} className="text-blue-500 drop-shadow-lg" />
            )}
          </div>

          {/* عرض الإحداثيات - أسفل اليسار */}
          <div className="absolute bottom-4 left-4 bg-black bg-opacity-80 text-white px-4 py-2 rounded-lg text-sm font-mono z-20 shadow-md">
            خط عرض = {currentCoords.lat.toFixed(8)} خط طول = {currentCoords.lng.toFixed(8)}
          </div>

          {/* معلومات الموقع - أسفل اليسار (فوق الإحداثيات) */}
          <div className="absolute bottom-16 left-4 bg-red-600 text-white px-3 py-1 rounded-lg text-sm flex items-center gap-2 z-20 shadow-md">
            <MapPin size={16} />
            {geoJsonLocationName 
              ? geoJsonLocationName
              : 'موقع غير معروف'
            }
          </div>

          {/* لوحة معلومات نتيجة البحث (مشروطة) */}
          {searchResultInfo && (
            <div className="absolute top-4 left-4 bg-white p-3 rounded-lg shadow-lg z-20 max-w-xs md:max-w-sm">
                <div className="flex justify-between items-center mb-2">
                    <h3 className="font-bold text-lg text-blue-700">نتيجة البحث</h3>
                    <button onClick={() => {
                      setSearchResultInfo(null);
                      // مسح التظليل على الخريطة عند إغلاق نتيجة البحث
                      if (highlightFeatureRef.current && map.data) {
                        map.data.revertStyle(); 
                        highlightFeatureRef.current = null;
                      }
                    }} className="text-gray-500 hover:text-gray-700">
                        <X size={20} /> {/* أيقونة إغلاق */}
                    </button>
                </div>
                <p className="text-sm font-semibold text-gray-700">الاسم: <span className="text-blue-600">{searchResultInfo.name}</span></p>
                {/* يمكنك إضافة المزيد من التفاصيل من searchResultInfo.feature.properties هنا */}
            </div>
          )}


          {/* أزرار التحكم - أعلى اليمين (مجموعة) */}
          <div className="absolute top-4 right-4 flex flex-col gap-2 z-20">
            {/* حقل إدخال البحث (مشروط) */}
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
                     if (highlightFeatureRef.current && map.data) {
                        map.data.revertStyle(); 
                        highlightFeatureRef.current = null;
                      }
                  }}
                  className="bg-gray-500 hover:bg-gray-600 text-white p-3 rounded-full shadow-lg transition-colors duration-200 ease-in-out"
                  title="إغلاق البحث"
                >
                  <X size={20} /> {/* أيقونة X من Lucide */}
                </button>
              </div>
            )}
            <div className="flex gap-2">
              {/* زر الصفحة الرئيسية */}
              <button
                onClick={resetToCenter}
                className="bg-green-600 hover:bg-green-700 text-white p-3 rounded-full shadow-lg transition-colors duration-200 ease-in-out transform hover:scale-105 focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-opacity-75"
                title="إعادة تعيين إلى المركز"
              >
                <Home size={20} />
              </button>

              {/* زر حول/مساعدة */}
              <button
                onClick={handleShowAboutModal}
                className="bg-purple-600 hover:bg-purple-700 text-white p-3 rounded-full shadow-lg transition-colors duration-200 ease-in-out transform hover:scale-105 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:ring-opacity-75"
                title="حول/مساعدة"
              >
                <Info size={20} />
              </button>

              {/* زر تبديل البحث */}
              <button
                onClick={() => setShowSearchInput(prev => !prev)}
                className="bg-indigo-600 hover:bg-indigo-700 text-white p-3 rounded-full shadow-lg transition-colors duration-200 ease-in-out transform hover:scale-105 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-opacity-75"
                title="تبديل البحث"
              >
                <Search size={20} />
              </button>

              {/* زر تبديل نوع الخريطة (Satellite/Roadmap) */}
              <button
                onClick={handleMapTypeToggle}
                className="bg-orange-600 hover:bg-orange-700 text-white p-3 rounded-full shadow-lg transition-colors duration-200 ease-in-out transform hover:scale-105 focus:outline-none focus:ring-2 focus:ring-orange-500 focus:ring-opacity-75"
                title={mapType === 'roadmap' ? 'عرض القمر الصناعي' : 'عرض خريطة الطريق'}
              >
                {mapType === 'roadmap' ? <Satellite size={20} /> : <MapIcon size={20} />}
              </button>
            </div> {/* نهاية مجموعة الأزرار العلوية اليمنى */}
          </div> {/* نهاية الحاوية المطلقة العلوية اليمنى */}

          {/* أزرار التحكم - أسفل اليمين (نسخ، تنزيل) */}
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

          {/* About/Help Modal (تنفيذ مخصص) */}
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
