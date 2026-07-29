import { ref, computed } from 'vue'

export default function setup(context) {
  const { trips, trip_group_dates, trip_packages } = context

  const filterDate = ref('')
  const filterPackageType = ref('')

  const filteredTrips = computed(() => {
    let result = trips.data || []

    if (filterDate.value) {
      const matchingTripNames = (trip_group_dates.data || [])
        .filter(function(d) { return d.departure_date === filterDate.value })
        .map(function(d) { return d.trip })
      result = result.filter(function(t) { return matchingTripNames.includes(t.name) })
    }

    if (filterPackageType.value) {
      const matchingTripNames = (trip_packages.data || [])
        .filter(function(p) { return p.package_type === filterPackageType.value })
        .map(function(p) { return p.trip_link })
      result = result.filter(function(t) { return matchingTripNames.includes(t.name) })
    }

    return result
  })

  const resetFilters = function() {
    filterDate.value = ''
    filterPackageType.value = ''
  }

  const tripCount = computed(() => filteredTrips.value.length)

  return {
    filterDate,
    filterPackageType,
    filteredTrips,
    resetFilters,
    tripCount,
  }
}
